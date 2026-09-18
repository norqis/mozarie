(() => {
  const gallery = document.querySelector("[data-gallery]");
  if (!gallery) return;

  const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
  const controls = gallery.querySelector("[data-gallery-controls]");
  const count = gallery.querySelector("[data-gallery-count]");
  const previous = gallery.querySelector("[data-gallery-prev]");
  const next = gallery.querySelector("[data-gallery-next]");
  const pause = gallery.querySelector("[data-gallery-pause]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let index = 0;
  let paused = reducedMotion;
  let hover = false;
  let timer;

  function setLiveMode() {
    slides.forEach((slide) => {
      slide.querySelector("[data-gallery-caption]").setAttribute("aria-live", paused || hover || document.hidden ? "polite" : "off");
    });
  }

  function stopTimer() {
    window.clearInterval(timer);
    timer = undefined;
  }

  function startTimer() {
    stopTimer();
    if (!paused && !hover && !document.hidden) timer = window.setInterval(() => show(index + 1), 6000);
  }

  function setControls() {
    pause.textContent = paused ? "再開" : "一時停止";
  }

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => { slide.hidden = slideIndex !== index; });
    count.textContent = `${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
  }

  function setPaused(value) {
    paused = value;
    setLiveMode();
    setControls();
    startTimer();
  }

  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  pause.addEventListener("click", () => setPaused(!paused));
  gallery.addEventListener("mouseenter", () => { hover = true; setLiveMode(); stopTimer(); });
  gallery.addEventListener("mouseleave", () => { hover = false; setLiveMode(); startTimer(); });
  gallery.addEventListener("focusin", (event) => {
    if (event.target !== pause) setPaused(true);
  });
  document.addEventListener("visibilitychange", () => { setLiveMode(); startTimer(); });

  controls.hidden = false;
  show(index);
  setPaused(paused);
})();
