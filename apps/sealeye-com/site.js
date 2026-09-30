// seaLeye.com. The only script on the site: the menu button below 900 px, and click,
// Escape and arrow keys for the Product dropdown. Hover and keyboard focus already open
// the dropdown from style.css, so the page works without this file except for the menu.
(function () {
  const bar = document.querySelector(".topbar");
  if (!bar) return;

  // ---- the menu button ----
  const menuBtn = bar.querySelector(".menubtn");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      const open = !bar.classList.contains("open");
      bar.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
    });
  }

  // ---- the Product dropdown ----
  const item = bar.querySelector(".hasdrop");
  if (!item) return;
  const trigger = item.querySelector(".drop");
  const links = Array.from(item.querySelectorAll(".dropmenu a"));

  const setOpen = open => {
    item.classList.toggle("open", open);
    // "closed" wins over hover and focus-within, so Escape really closes it.
    item.classList.toggle("closed", !open);
    trigger.setAttribute("aria-expanded", String(open));
  };

  trigger.addEventListener("click", () => {
    setOpen(trigger.getAttribute("aria-expanded") !== "true");
  });

  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      // Stop here, or the menu's own handler below sees the same key and moves on again.
      event.stopPropagation();
      setOpen(true);
      links[0].focus();
    }
  });

  item.addEventListener("keydown", event => {
    const at = links.indexOf(document.activeElement);
    if (event.key === "Escape") {
      setOpen(false);
      trigger.focus();
    } else if (at >= 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
      links[next].focus();
    }
  });

  // Hovering again after an Escape opens it again, the way it did before.
  item.addEventListener("mouseenter", () => item.classList.remove("closed"));
  item.addEventListener("mouseleave", () => {
    if (!item.contains(document.activeElement)) setOpen(false);
    item.classList.remove("closed");
  });

  item.addEventListener("focusout", event => {
    if (!item.contains(event.relatedTarget)) {
      setOpen(false);
      item.classList.remove("closed");
    }
  });

  document.addEventListener("click", event => {
    if (!item.contains(event.target)) {
      setOpen(false);
      item.classList.remove("closed");
    }
  });
})();
