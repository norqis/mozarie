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
  let paused = reducedMotion;
  let hover = false;
  let timer;

  function stopTimer() {
    window.clearInterval(timer);
    timer = undefined;
  }

  function startTimer() {
    stopTimer();
    if (!paused && !hover && !document.hidden) timer = window.setInterval(() => show(index + 1), 6000);
  }

  function setControls() {
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", String(dotIndex === index)));
    pause.setAttribute("aria-label", paused ? "自動再生を再開" : "自動再生を一時停止");
    pause.innerHTML = paused
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5z"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10"/></svg>';
  }

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index;
      slide.hidden = !active;
      if (active) {
        slide.classList.remove("gallery-entering");
        void slide.offsetWidth;
        slide.classList.add("gallery-entering");
      }
    });
    setControls();
  }

  function setPaused(value) {
    paused = value;
    setControls();
    startTimer();
  }

  previous.addEventListener("click", () => { setPaused(true); show(index - 1); });
  next.addEventListener("click", () => { setPaused(true); show(index + 1); });
  dots.forEach((dot) => dot.addEventListener("click", () => { setPaused(true); show(Number(dot.dataset.galleryDot)); }));
  pause.addEventListener("click", () => setPaused(!paused));
  gallery.addEventListener("mouseenter", () => { hover = true; stopTimer(); });
  gallery.addEventListener("mouseleave", () => { hover = false; startTimer(); });
  gallery.addEventListener("focusin", (event) => {
    if (event.target !== pause) setPaused(true);
  });
  document.addEventListener("visibilitychange", startTimer);

  controls.hidden = false;
  show(index);
  setPaused(paused);
})();
