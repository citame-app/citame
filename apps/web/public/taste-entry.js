// Native public modules keep the unmodified taste kit out of Vite's application graph.

import { mount } from "./taste/moments/moments.js";
import { refresh } from "./taste/motion/motion.js";

const activate = () => {
  if (!document.querySelector(".salon-hero")) return;
  refresh();
  const frame = document.querySelector(".salon-offer-photo");
  if (frame)
    mount(frame).catch(() => {
      frame.classList.add("mo-safe");
    });
};
window.addEventListener("sob:public-mounted", activate);
window.addEventListener("sob:public-unmounted", (event) => {
  const frame = event.detail;
  Promise.resolve(frame?.__momentP)
    .then((api) => api?.destroy?.())
    .catch(() => {});
  if (frame) {
    delete frame.__momentP;
    delete frame.__moment;
  }
});
activate();
