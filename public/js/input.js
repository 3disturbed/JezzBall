// Pointer + touch input: hover aims the ghost preview, click/tap builds,
// right-click / two-finger tap / the ⇕ button toggles the axis.
import { W, H } from '/shared/sim.js';

export function attachInput(canvas, game, { requestBuild, toggleAxis }) {
  const cellFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = Math.floor(((e.clientX - rect.left) / rect.width) * W);
    const cy = Math.floor(((e.clientY - rect.top) / rect.height) * H);
    return { cx, cy };
  };

  canvas.addEventListener('pointermove', (e) => {
    game.aim = cellFromEvent(e);
  });
  canvas.addEventListener('pointerleave', () => {
    game.aim = null;
  });

  let lastTouchTap = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      // First touch aims (shows the preview); a quick second tap on roughly
      // the same cell builds. Dragging updates the aim continuously.
      const cell = cellFromEvent(e);
      const prev = game.aim;
      game.aim = cell;
      const now = Date.now();
      if (prev && Math.abs(prev.cx - cell.cx) <= 1 && Math.abs(prev.cy - cell.cy) <= 1 && now - lastTouchTap < 900) {
        requestBuild(cell.cx, cell.cy);
      }
      lastTouchTap = now;
      return;
    }
    if (e.button === 2) return; // handled by contextmenu
    const { cx, cy } = cellFromEvent(e);
    requestBuild(cx, cy);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleAxis();
  });

  // Two-finger tap toggles axis on touch devices.
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      toggleAxis();
    }
  }, { passive: false });

  document.getElementById('btn-axis').addEventListener('click', toggleAxis);
}
