(() => {
  const gallery = document.querySelector("[data-gallery]");
  const modal = document.querySelector("[data-gallery-modal]");
  if (!gallery || !modal) return;

  const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
  const controls = [...gallery.querySelectorAll("[data-gallery-controls]")];
  const previous = gallery.querySelector("[data-gallery-prev]");
  const next = gallery.querySelector("[data-gallery-next]");
  const dots = [...gallery.querySelectorAll("[data-gallery-dot]")];
  const caption = gallery.querySelector("[data-gallery-caption]");
  const peeks = [gallery.querySelector("[data-gallery-peek-previous]"), gallery.querySelector("[data-gallery-peek-next]")];
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
      const active = slideIndex === index;
      const button = slide.querySelector("[data-gallery-open]");
      slide.hidden = !active;
      slide.dataset.galleryPosition = active ? "active" : "inactive";
      slide.toggleAttribute("inert", !active);
      slide.setAttribute("aria-hidden", String(!active));
      button.disabled = !active;
    });
    const neighborImage = slides[(index + 1) % slides.length].querySelector("img");
    peeks.forEach((peek) => { peek.src = neighborImage.currentSrc || neighborImage.src; });
    if (caption) caption.textContent = index === 0
      ? "自動検出した範囲を、モザイク結果と適用範囲で確認できます。"
      : "画像一覧、ブラシ、候補、保存操作を1つの画面で扱えます。";
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
