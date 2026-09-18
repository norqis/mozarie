(() => {
  const gallery = document.querySelector("[data-gallery]");
  const modal = document.querySelector("[data-gallery-modal]");
  if (!gallery || !modal) return;

  const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
  const controls = [...gallery.querySelectorAll("[data-gallery-controls]")];
  const previous = gallery.querySelector("[data-gallery-prev]");
  const next = gallery.querySelector("[data-gallery-next]");
  const dots = [...gallery.querySelectorAll("[data-gallery-dot]")];
  const featurePreviews = [...document.querySelectorAll("[data-feature-open]")];
  const modalClose = modal.querySelector("[data-gallery-modal-close]");
  const modalImage = modal.querySelector("[data-gallery-modal-image]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let index = 0;
  let keyboardSuspended = false;
  let timer;
  let modalOpener;

  function stopTimer() {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    stopTimer();
    if (!reducedMotion && !keyboardSuspended && !document.hidden && !modal.open) {
      timer = window.setTimeout(() => {
        show(index + 1);
        schedule();
      }, 6000);
    }
  }

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const distance = (slideIndex - index + slides.length) % slides.length;
      const position = distance === 0 ? "active" : distance === 1 ? "next" : "previous";
      const active = position === "active";
      const button = slide.querySelector("[data-gallery-open]");
      slide.hidden = false;
      slide.dataset.galleryPosition = position;
      slide.toggleAttribute("inert", !active);
      slide.setAttribute("aria-hidden", String(!active));
      button.disabled = !active;
    });
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", String(dotIndex === index)));
  }

  function move(nextIndex) {
    show(nextIndex);
    schedule();
  }

  function openModal(button) {
    const image = button.querySelector("img");
    modalOpener = button;
    modalImage.src = image.currentSrc || image.src;
    modalImage.alt = image.alt;
    stopTimer();
    modal.showModal();
  }

  previous.addEventListener("click", () => move(index - 1));
  next.addEventListener("click", () => move(index + 1));
  dots.forEach((dot) => dot.addEventListener("click", () => move(Number(dot.dataset.galleryDot))));
  [...slides.map((slide) => slide.querySelector("[data-gallery-open]")), ...featurePreviews].forEach((button) => {
    button.disabled = false;
    button.addEventListener("click", (event) => openModal(event.currentTarget));
  });
  gallery.addEventListener("pointerdown", () => {
    keyboardSuspended = false;
    schedule();
  });
  gallery.addEventListener("focusin", (event) => {
    if (event.target.matches(":focus-visible")) {
      keyboardSuspended = true;
      stopTimer();
    }
  });
  gallery.addEventListener("keydown", () => {
    keyboardSuspended = true;
    stopTimer();
  });
  gallery.addEventListener("focusout", (event) => {
    if (!gallery.contains(event.relatedTarget) && !modal.open) {
      keyboardSuspended = false;
      schedule();
    }
  });
  document.addEventListener("visibilitychange", schedule);
  modalClose.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });
  modal.addEventListener("close", () => {
    const opener = modalOpener;
    opener?.focus();
    keyboardSuspended = Boolean(opener && gallery.contains(opener) && opener.matches(":focus-visible"));
    modalOpener = undefined;
    schedule();
  });

  controls.forEach((control) => { control.hidden = false; });
  show(index);
  schedule();
})();
