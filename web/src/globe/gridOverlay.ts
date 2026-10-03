import {
  ClassificationType,
  EllipsoidSurfaceAppearance,
  GeometryInstance,
  GroundPrimitive,
  Material,
  Rectangle,
  RectangleGeometry,
  type Viewer,
} from "cesium";
import type { GridInfo } from "../types/events";

/** RGBA for one cell, or null for transparent. */
export type CellColor = [number, number, number, number] | null;

const UPSCALE = 4;

/**
 * Paints a value per grid cell into one image and drapes it over the zone as a
 * single ground primitive (terrain and 3D tiles). Never one entity per cell.
 */
export class GridOverlay {
  private readonly primitive: GroundPrimitive;
  private readonly material: Material;
  private readonly canvas = document.createElement("canvas");
  private readonly small = document.createElement("canvas");

  constructor(
    private readonly viewer: Viewer,
    private readonly grid: GridInfo,
  ) {
    this.small.width = grid.cols;
    this.small.height = grid.rows;
    this.canvas.width = grid.cols * UPSCALE;
    this.canvas.height = grid.rows * UPSCALE;
    this.material = Material.fromType("Image", { image: this.blank() });
    this.primitive = new GroundPrimitive({
      geometryInstances: new GeometryInstance({
        geometry: new RectangleGeometry({
          rectangle: Rectangle.fromDegrees(grid.west, grid.south, grid.east, grid.north),
          vertexFormat: EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        }),
      }),
      appearance: new EllipsoidSurfaceAppearance({ aboveGround: false, material: this.material }),
      classificationType: ClassificationType.BOTH,
    });
    viewer.scene.primitives.add(this.primitive);
  }

  private blank(): string {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL();
  }

  /** Repaint every cell. Row 0 is the southern edge, so rows flip on the canvas. */
  paint(color: (index: number) => CellColor): void {
    const { rows, cols } = this.grid;
    const ctx = this.small.getContext("2d")!;
    const image = ctx.createImageData(cols, rows);
    for (let row = 0; row < rows; row++) {
      const y = rows - 1 - row;
      for (let col = 0; col < cols; col++) {
        const rgba = color(row * cols + col);
        if (!rgba) continue;
        const o = (y * cols + col) * 4;
        image.data[o] = rgba[0];
        image.data[o + 1] = rgba[1];
        image.data[o + 2] = rgba[2];
        image.data[o + 3] = rgba[3];
      }
    }
    ctx.putImageData(image, 0, 0);
    const big = this.canvas.getContext("2d")!;
    big.clearRect(0, 0, this.canvas.width, this.canvas.height);
    big.imageSmoothingEnabled = false;
    big.drawImage(this.small, 0, 0, this.canvas.width, this.canvas.height);
    this.material.uniforms.image = this.canvas.toDataURL();
  }

  set show(value: boolean) {
    this.primitive.show = value;
  }

  destroy(): void {
    if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.primitive);
  }
}
