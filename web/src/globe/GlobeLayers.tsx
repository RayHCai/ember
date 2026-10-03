import { CoverageLayer } from "./layers/CoverageLayer";
import { EdgeLayer } from "./layers/EdgeLayer";
import { PlacesLayer } from "./layers/PlacesLayer";
import { ZonesLayer } from "./layers/ZonesLayer";
import { DrawZoneTool } from "./tools/DrawZoneTool";
import { EdgeEditTool } from "./tools/EdgeEditTool";
import { ShelterEditTool } from "./tools/ShelterEditTool";

/** Everything drawn on the globe, bottom to top, plus the editing tools. */
export function GlobeLayers() {
  return (
    <>
      <CoverageLayer />
      <ZonesLayer />
      <PlacesLayer />
      <EdgeLayer />
      <DrawZoneTool />
      <EdgeEditTool />
      <ShelterEditTool />
    </>
  );
}
