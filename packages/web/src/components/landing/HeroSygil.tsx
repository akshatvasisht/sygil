"use client";

import React from "react";

/*
 * Procedurally computes grid centers and maps them against the DAG's topological flow.
 * Route: Bottom-Left -> Bottom Edge -> Bottom-Right -> Diagonal Edge -> Top-Left -> Top Edge -> Top-Right.
 */
const gridSquares = (() => {
  const squares: { x: string; y: string; delay: string }[] = [];
  const inRect = (x: number, y: number, rx: number, ry: number, rw: number, rh: number) => {
    return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
  };

  const angle18 = 18 * Math.PI / 180;
  const cos18 = Math.cos(angle18);
  const sin18 = Math.sin(angle18);

  const angle45 = -45 * Math.PI / 180;
  const cos45 = Math.cos(angle45);
  const sin45 = Math.sin(angle45);

  const getFlowDistance = (lx: number, ly: number) => {
    const distS1 = Math.abs(ly - 144);
    const distS2 = Math.abs(lx - ly) / Math.SQRT2;
    const distS3 = Math.abs(ly - 368);

    let min = distS1;
    if (distS2 < min) min = distS2;
    if (distS3 < min) min = distS3;

    if (min === distS3 && lx <= 368) {
      // 1. Bottom Edge (N4 to N3)
      // Moving left to right: lx starts around 96 and hits N3 center at 368.
      return lx;
    } else if (min === distS1 && lx >= 144) {
      // 3. Top Edge (N1 to N2)
      // Starts at N1 center (144). Diagonal sequence up to N1 center distance was 684.78.
      // Moving left to right: lx limits out around 416. 
      return 684.78 + (lx - 144);
    } else {
      // 2. Diagonal Edge (N3 to N1)
      // Moving bottom-right to top-left: t = (lx+ly)/2 goes from 368 down to 144.
      const t = (lx + ly) / 2;
      return 368 + (368 - t) * Math.SQRT2;
    }
  };

  const SPEED = 130;
  const DURATION = 9.0;

  for (let iy = 0; iy < 57; iy++) {
    for (let ix = 0; ix < 57; ix++) {
      const cx = ix * 9 + 4.5;
      const cy = iy * 9 + 4.5;

      const dx = cx - 256;
      const dy = cy - 256;
      const lx = dx * cos18 - dy * sin18 + 256;
      const ly = dx * sin18 + dy * cos18 + 256;

      let inside = false;
      let nodeCenter: [number, number] | null = null;

      if (inRect(lx, ly, 96, 96, 96, 96)) { inside = true; nodeCenter = [144, 144]; }
      else if (inRect(lx, ly, 320, 96, 96, 96)) { inside = true; nodeCenter = [368, 144]; }
      else if (inRect(lx, ly, 320, 320, 96, 96)) { inside = true; nodeCenter = [368, 368]; }
      else if (inRect(lx, ly, 96, 320, 96, 96)) { inside = true; nodeCenter = [144, 368]; }
      else if (inRect(lx, ly, 144, 120, 224, 48)) inside = true;
      else if (inRect(lx, ly, 144, 344, 224, 48)) inside = true;
      else {
        const ldx = lx - 256;
        const ldy = ly - 256;
        const llx = ldx * cos45 - ldy * sin45 + 256;
        const lly = ldx * sin45 + ldy * cos45 + 256;

        if (inRect(llx, lly, 97.61, 232, 316.78, 48)) inside = true;
      }

      if (inside) {
        // If the pixel is inside a corner component, we assign it the exact distance of the node's center.
        // This ensures the entire block lights up simultaneously as a singular entity.
        const d = nodeCenter ? getFlowDistance(nodeCenter[0], nodeCenter[1]) : getFlowDistance(lx, ly);

        // Map distance to an animation phase from 0 to T
        const phase = (d - 96) / SPEED;
        // Use a negative delay so the CSS cycles seamlessly from the proper time offset
        const delay = - (DURATION - (phase % DURATION));

        // Add microscopic pseudo-random variation (0s to 0.08s) mimicking digital signal scattering
        const scatter = ((ix * 13 + iy * 29) % 8) / 100;

        squares.push({
          x: (ix * 9 + 1.8).toFixed(2),
          y: (iy * 9 + 1.8).toFixed(2),
          delay: (delay + scatter).toFixed(3),
        });
      }
    }
  }

  return squares;
})();

/**
 * Renders the deterministic DAG logo as a static SVG, animated with a traveling wave of light.
 */
export function HeroSygil() {
  return (
    <svg
      viewBox="0 0 512 512"
      width="100%"
      height="100%"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {/* Base geometry styling — .sygil-travel and @keyframes sygilWave are in globals.css */}
      <g fill="#FF5C00">
        {gridSquares.map((sq, i) => (
          <rect
            key={i}
            x={sq.x}
            y={sq.y}
            width="5.4"
            height="5.4"
            className="sygil-travel"
            style={{ animationDelay: `${sq.delay}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
