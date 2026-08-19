// Pointer + touch input.
// Desktop: hover aims the ghost preview, click builds, right-click / Space
// toggles the axis.
// Touch: tap aims (moves the preview), swipe LAUNCHES — the wall starts at
// the cell where the finger went down, and the swipe direction picks the
// axis (horizontal swipe -> horizontal wall). The ⇕ button and two-finger
// tap still toggle the axis for the preview.
import { W, H } from '/shared/sim.js?v=5';

const SWIPE_PX = 22; // finger travel that turns a tap into a launch

export function attachInput(canvas, game, { requestBuild, toggleAxis, setAxis }) {
  const cellFromPoint = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const cx = Math.floor(((clientX - rect.left) / rect.width) * W);
    const cy = Math.floor(((clientY - rect.top) / rect.height) * H);
    return { cx, cy };
  };

  // ----- desktop mouse -----
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    game.aim = cellFromPoint(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    game.aim = null;
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button === 2) return; // handled by contextmenu
    const { cx, cy } = cellFromPoint(e.clientX, e.clientY);
    requestBuild(cx, cy);
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleAxis();
  });

  // ----- touch: tap to aim, swipe to launch -----
  let touch = null; // {id, x0, y0, cell, launched}
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      touch = null; // second finger cancels a pending launch
      toggleAxis();
      return;
    }
    const t = e.changedTouches[0];
    touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, cell: cellFromPoint(t.clientX, t.clientY) };
    game.aim = touch.cell; // preview appears immediately, anchored here
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = [...e.changedTouches].find((x) => x.identifier === touch.id);
    if (!t) return;
    e.preventDefault(); // the arena is not for scrolling
    const dx = t.clientX - touch.x0;
    const dy = t.clientY - touch.y0;
    if (Math.hypot(dx, dy) >= SWIPE_PX) {
      // Live-orient the anchored preview to match the swipe direction.
      setAxis(Math.abs(dx) > Math.abs(dy) ? 'h' : 'v');
      game.aim = touch.cell;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = [...e.changedTouches].find((x) => x.identifier === touch.id);
    if (!t) return;
    const dx = t.clientX - touch.x0;
    const dy = t.clientY - touch.y0;
    if (Math.hypot(dx, dy) >= SWIPE_PX) {
      setAxis(Math.abs(dx) > Math.abs(dy) ? 'h' : 'v');
      requestBuild(touch.cell.cx, touch.cell.cy);
    }
    // Below threshold: it was a tap — the preview stays where it was aimed.
    touch = null;
  });
  canvas.addEventListener('touchcancel', () => {
    touch = null;
  });

  document.getElementById('btn-axis').addEventListener('click', toggleAxis);
}
