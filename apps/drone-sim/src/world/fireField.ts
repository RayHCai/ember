import type { FireGrid } from './assets';

export type CellState = { intensity: number; smoulder: number; post: number };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * One cell of Demo Data's fire model (`model/state.py`, `FireScenario._compute`) at `minute`
 * after the rekindle: flaming intensity, smouldering heat, and how much of the post-fire
 * surface shows.
 */
export function cellState(
    arrival: number,
    flame: number,
    smoulder: number,
    heat: number,
    minute: number,
): CellState {
    if (heat <= 0) return { intensity: 0, smoulder: 0, post: 0 };
    const since = minute - arrival;
    let intensity = 0;
    let sm = 0;
    if (since >= 0 && since < flame) {
        const x = since / flame;
        intensity = clamp(heat * Math.min(1, x / 0.12) * Math.sqrt(clamp(1 - x, 0, 1)) * 1.1, 0, 1);
    } else if (since >= flame && since < flame + smoulder) {
        sm = heat * 0.6 * Math.exp((-3 * (since - flame)) / smoulder);
    }
    return { intensity, smoulder: sm, post: clamp((since - 0.5 * flame) / (0.5 * flame), 0, 1) };
}

function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
    const tmp = new Float32Array(w * h);
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)]!;
        for (let x = 0; x < w; x++) {
            tmp[row + x] = acc * norm;
            acc += src[row + Math.min(x + r + 1, w - 1)]! - src[row + Math.max(x - r, 0)]!;
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x]!;
        for (let y = 0; y < h; y++) {
            dst[y * w + x] = acc * norm;
            acc += tmp[Math.min(y + r + 1, h - 1) * w + x]! - tmp[Math.max(y - r, 0) * w + x]!;
        }
    }
}

/**
 * The fire state over the whole grid at one moment, as a texture (R intensity, G smoulder,
 * B post-fire surface, A firelight glow) plus the burning and smouldering cells that drive
 * 3D flames and smoke.
 */
export class FireField {
    readonly texture: Uint8Array;
    readonly intensity: Float32Array;
    readonly smoulder: Float32Array;
    /** Indices of cells with flames (intensity > 0.02), valid up to `burningCount`. */
    readonly burning: Int32Array;
    burningCount = 0;
    readonly smouldering: Int32Array;
    smoulderingCount = 0;
    totalIntensity = 0;
    minute = Number.NaN;

    private readonly active: Int32Array;
    private readonly glow: Float32Array;
    private readonly blurA: Float32Array;

    constructor(readonly grid: FireGrid) {
        const n = grid.width * grid.height;
        this.texture = new Uint8Array(n * 4);
        this.intensity = new Float32Array(n);
        this.smoulder = new Float32Array(n);
        this.glow = new Float32Array(n);
        this.blurA = new Float32Array(n);
        const active: number[] = [];
        for (let i = 0; i < n; i++) if (grid.cells[i * 4 + 3]! > 0) active.push(i);
        this.active = Int32Array.from(active);
        this.burning = new Int32Array(this.active.length);
        this.smouldering = new Int32Array(this.active.length);
    }

    update(minute: number): void {
        this.minute = minute;
        const { cells } = this.grid;
        const tex = this.texture;
        this.burningCount = 0;
        this.smoulderingCount = 0;
        this.totalIntensity = 0;
        for (let k = 0; k < this.active.length; k++) {
            const i = this.active[k]!;
            const s = cellState(
                cells[i * 4]!,
                cells[i * 4 + 1]!,
                cells[i * 4 + 2]!,
                cells[i * 4 + 3]!,
                minute,
            );
            this.intensity[i] = s.intensity;
            this.smoulder[i] = s.smoulder;
            tex[i * 4] = Math.round(s.intensity * 255);
            tex[i * 4 + 1] = Math.round(clamp(s.smoulder / 0.6, 0, 1) * 255);
            tex[i * 4 + 2] = Math.round(s.post * 255);
            if (s.intensity > 0.02) {
                this.burning[this.burningCount++] = i;
                this.totalIntensity += s.intensity;
            } else if (s.smoulder > 0.02) {
                this.smouldering[this.smoulderingCount++] = i;
            }
        }
        const { width: w, height: h } = this.grid;
        // Firelight reaches a few hundred metres (model/state.py blurs intensity with sigma 4 cells).
        if (this.burningCount + this.smoulderingCount > 0) {
            for (let i = 0; i < w * h; i++)
                this.blurA[i] = this.intensity[i]! * 3 + this.smoulder[i]! * 0.6;
            boxBlur(this.blurA, this.glow, w, h, 3);
            boxBlur(this.glow, this.blurA, w, h, 3);
            for (let i = 0; i < w * h; i++)
                tex[i * 4 + 3] = Math.round(clamp(this.blurA[i]!, 0, 1) * 255);
        } else {
            for (let i = 0; i < w * h; i++) tex[i * 4 + 3] = 0;
        }
    }

    /** World-frame centre of cell `i`. */
    cellCentre(i: number): { x: number; y: number } {
        const { width, cellM, extent } = this.grid;
        return {
            x: extent.minX + ((i % width) + 0.5) * cellM,
            y: extent.minY + (Math.floor(i / width) + 0.5) * cellM,
        };
    }
}
