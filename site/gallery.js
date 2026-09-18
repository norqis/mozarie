(() => {
  const gallery = document.querySelector("[data-gallery]");
  if (!gallery) return;

  const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
  const controls = gallery.querySelector("[data-gallery-controls]");
  const previous = gallery.querySelector("[data-gallery-prev]");
  const next = gallery.querySelector("[data-gallery-next]");
  const dots = [...gallery.querySelectorAll("[data-gallery-dot]")];
  const pause = gallery.querySelector("[data-gallery-pause]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let index = 0;
  let explicitPaused = reducedMotion;
  let keyboardSuspended = false;
  let timer;

  function stopTimer() {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    stopTimer();
    if (!explicitPaused && !keyboardSuspended && !document.hidden) {
      timer = window.setTimeout(() => {
        show(index + 1);
        schedule();
      }, 6000);
    }
  }

  function setControls() {
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", String(dotIndex === index)));
    pause.setAttribute("aria-label", explicitPaused ? "自動再生を再開" : "自動再生を一時停止");
    pause.innerHTML = explicitPaused
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5z"></path></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10"></path></svg>';
  }

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index;
      slide.hidden = !active;
      if (active && !reducedMotion) {
        slide.classList.remove("gallery-entering");
        void slide.offsetWidth;
        slide.classList.add("gallery-entering");
      }
    });
    setControls();
  }

  function move(nextIndex) {
    show(nextIndex);
    schedule();
  }

  previous.addEventListener("click", () => move(index - 1));
  next.addEventListener("click", () => move(index + 1));
  dots.forEach((dot) => dot.addEventListener("click", () => move(Number(dot.dataset.galleryDot))));
  pause.addEventListener("click", () => {
    explicitPaused = !explicitPaused;
    if (!explicitPaused) keyboardSuspended = false;
    setControls();
    schedule();
  });
  gallery.addEventListener("pointerdown", () => {
    keyboardSuspended = false;
    schedule();
  });
  gallery.addEventListener("focusin", (event) => {
    if (event.target !== pause && event.target.matches(":focus-visible")) {
      keyboardSuspended = true;
      stopTimer();
    }
  });
  gallery.addEventListener("keydown", () => {
    keyboardSuspended = true;
    stopTimer();
  });
  gallery.addEventListener("focusout", (event) => {
    if (!gallery.contains(event.relatedTarget)) {
      keyboardSuspended = false;
      schedule();
    }
  });
  document.addEventListener("visibilitychange", schedule);

  controls.hidden = false;
  show(index);
  schedule();
})();
