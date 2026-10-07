"""Progress publication stays linear and each poll owns a coherent result."""
from __future__ import annotations

import threading
import unittest

from mozarie.core import Job
from tests import test_server


class CountedIds(tuple):
    """Count visits to input records, independently of machine speed."""

    def __new__(cls, values):
        instance = super().__new__(cls, values)
        instance.visits = 0
        return instance

    def __iter__(self):
        for value in super().__iter__():
            self.visits += 1
            yield value


class JobProgressPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = test_server.MozarieTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state = self.fixture.new_state()

    def test_recording_progress_does_not_rescan_the_catalogue_per_image(self) -> None:
        count = 512
        image_ids = CountedIds(str(index) for index in range(count))
        self.state.job = Job(kind="apply", state="running", total=count, image_ids=image_ids)
        for index in reversed(range(count)):
            self.state._set_job_current(f"{index}.png")
            self.state._record_job_success(index, str(index), f"out/{index}.png")
        self.assertLessEqual(image_ids.visits, count * 4,
                             "per-image progress must not walk the whole catalogue")
        result = self.state.job_snapshot()
        self.assertEqual(result["completed"], count)
        self.assertEqual(result["completedImageIds"], [str(index) for index in range(count)])
        self.assertEqual(result["outputs"], [f"out/{index}.png" for index in range(count)])

    def test_old_publication_keeps_its_prefix_after_more_results_and_a_new_job(self) -> None:
        state = self.state
        state.job = Job(kind="apply", state="running", total=3, image_ids=("a", "b", "c"))
        state._record_job_success(2, "c", "out/c.png")
        publication = state._job_snapshot
        first = state.job_snapshot()
        state._record_job_success(0, "a", "out/a.png")
        state._record_job_success(0, "a", "out/a.png")
        state._record_job_success(1, "b", None)
        self.assertEqual(state.job_snapshot()["completedImageIds"], ["a", "b", "c"])
        self.assertEqual(state.job.outputs, ["out/a.png", "out/c.png"])
        self.assertEqual(state.job.completed_image_ids, ("a", "b", "c"))
        public = state.job.as_dict()
        self.assertEqual(public, state.job_snapshot())
        public["imageIds"].clear()
        public["outputs"].clear()
        public["completedImageIds"].clear()
        self.assertEqual(state.job.as_dict()["outputs"], ["out/a.png", "out/c.png"])
        self.assertEqual(state.job.as_dict()["completedImageIds"], ["a", "b", "c"])
        self.assertEqual(state._copy_job_snapshot(publication), first)
        state.job = Job(kind="detect", state="running", total=1, image_ids=("next",))
        state._mark_job_processed()
        staged = state.job_snapshot()
        self.assertEqual((staged["processed"], staged["completed"]), (1, 0))
        self.assertEqual(staged["completedImageIds"], [])
        self.assertEqual(staged["outputs"], [])
        state._record_job_success(0, "next", None)
        self.assertEqual(state.job_snapshot()["completedImageIds"], ["next"])
        self.assertEqual(state._copy_job_snapshot(publication), first)
        first["imageIds"].clear()
        first["outputs"].clear()
        first["completedImageIds"].clear()
        previous = state._copy_job_snapshot(publication)
        self.assertEqual(previous["imageIds"], ["a", "b", "c"])
        self.assertEqual(previous["completedImageIds"], ["c"])
        self.assertEqual(previous["outputs"], ["out/c.png"])

    def test_polling_a_busy_writer_returns_one_complete_publication(self) -> None:
        state = self.state
        state.job = Job(kind="apply", state="running", total=2, image_ids=("a", "b"))
        state._record_job_success(1, "b", "out/b.png")
        ready = threading.Event()
        release = threading.Event()

        def writer() -> None:
            with state.lock:
                ready.set()
                release.wait(5)
                state._record_job_success(0, "a", "out/a.png")

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            self.assertTrue(ready.wait(5))
            snapshot = state.job_snapshot()
            self.assertFalse(release.is_set())
            self.assertEqual(snapshot["completed"], 1)
            self.assertEqual(snapshot["completedImageIds"], ["b"])
            self.assertEqual(snapshot["outputs"], ["out/b.png"])
        finally:
            release.set()
            test_server.join_thread(thread)
        self.assertEqual(state.job_snapshot()["completedImageIds"], ["a", "b"])
        self.assertEqual(snapshot["completedImageIds"], ["b"])
