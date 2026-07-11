import type { Cut } from "../storage/jobs-db";

/**
 * Auf der Master-Timeline aufgespanntes Intervall einer Cam.
 *
 * `startS` inklusiv, `endS` exklusiv. Außerhalb dieses Intervalls hat die
 * Cam kein Material und kann nicht aktiv sein.
 */
export interface CamRange {
  id: string;
  startS: number;
  endS: number;
}

/**
 * Bestimmt die aktive Cam zum Zeitpunkt `t` auf der Master-Timeline.
 *
 * Regeln:
 *   1. Zieht den letzten Cut mit `atTimeS ≤ t`. Wenn dessen Cam an `t`
 *      Material hat → diese Cam.
 *   2. Wenn nicht (Cut zeigt auf eine Cam ohne Material, oder Ziel-Cam
 *      existiert nicht) → fällt auf die erste Cam (per Index) zurück, die
 *      an `t` Material hat.
 *   3. Wenn keine Cam Material hat → `null` (= Testbild).
 *
 * Cuts müssen nicht vorsortiert sein.
 */
export function activeCamAt(
  cuts: readonly Cut[],
  t: number,
  cams: readonly CamRange[],
): string | null {
  const camsById = new Map(cams.map((c) => [c.id, c]));

  // Schritt 1: letzter gültiger Cut mit atTimeS ≤ t
  let chosen: string | null = null;
  let bestAt = -Infinity;
  for (const cut of cuts) {
    if (cut.atTimeS <= t && cut.atTimeS > bestAt && camsById.has(cut.camId)) {
      bestAt = cut.atTimeS;
      chosen = cut.camId;
    }
  }

  if (chosen !== null) {
    const cam = camsById.get(chosen)!;
    if (t >= cam.startS && t < cam.endS) return chosen;
    // Cut zeigt auf Cam ohne Material an t → Fallback unten
  }

  // Schritt 2/3: erste Cam (per Index) mit Material an t
  for (const cam of cams) {
    if (t >= cam.startS && t < cam.endS) return cam.id;
  }
  return null;
}
