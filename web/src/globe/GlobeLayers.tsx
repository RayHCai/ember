import { CoverageLayer } from "./layers/CoverageLayer";
import { DronesLayer } from "./layers/DronesLayer";
import { EdgeLayer } from "./layers/EdgeLayer";
import { PlacesLayer } from "./layers/PlacesLayer";
import { SurveyLayer } from "./layers/SurveyLayer";
import { ZonesLayer } from "./layers/ZonesLayer";
import { DrawZoneTool } from "./tools/DrawZoneTool";
import { EdgeEditTool } from "./tools/EdgeEditTool";
import { SelectTool } from "./tools/SelectTool";
import { ShelterEditTool } from "./tools/ShelterEditTool";

/** Everything drawn on the globe, bottom to top, plus the editing tools. */
export function GlobeLayers() {
  return (
    <>
      <CoverageLayer />
      <SurveyLayer />
      <ZonesLayer />
      <PlacesLayer />
      <EdgeLayer />
      <DronesLayer />
      <SelectTool />
      <DrawZoneTool />
      <EdgeEditTool />
      <ShelterEditTool />
    </>
  );
}
