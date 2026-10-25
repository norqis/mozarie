"""Project details read stored metadata without opening or scanning sources."""
import unittest
from unittest.mock import patch

from tests import test_settings_import_regressions as import_fixture


class ProjectDetailsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = import_fixture.SettingsImportRegressionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state = self.fixture.state
        self.state.set_root(str(self.fixture.source))

    def test_unnamed_workspace_and_missing_project_are_not_exposed(self):
        for project_id in [self.state.workspace_id, "missing"]:
            status, response = self.fixture.request(f"/api/project/detail?projectId={project_id}")
            self.assertEqual(status, 400, response)
            self.assertEqual(response["error_code"], "project_not_found")

    def test_details_include_full_unavailable_paths_without_opening_or_scanning(self):
        project = self.state.name_current_project("詳細")
        native_path = "G:\\存在しない保存元\\" + "長いフォルダー\\" * 15
        with self.state.workspace_store._connect() as db:
            db.execute("UPDATE project_sources SET native_path=? WHERE catalog_id=?", (native_path, project["id"]))
        before = (self.state.images, self.state.catalog_generation, self.state.catalog_id)
        with patch.object(self.state, "open_project", side_effect=AssertionError("details must not open the project")), \
             patch.object(self.state, "source_mismatch_snapshot", side_effect=AssertionError("details must not inspect images")):
            status, response = self.fixture.request(f"/api/project/detail?projectId={project['id']}")
        self.assertEqual(status, 200, response)
        self.assertEqual(response["project"]["name"], "詳細")
        self.assertEqual(response["sources"][0]["nativePath"], native_path)
        self.assertEqual(set(response["sources"][0]), {"kind", "displayName", "nativePath"})
        self.assertIs(self.state.images, before[0])
        self.assertEqual((self.state.catalog_generation, self.state.catalog_id), before[1:])
