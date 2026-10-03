import { CoverageLayer } from "./layers/CoverageLayer";
import { DronesLayer } from "./layers/DronesLayer";
import { EdgeLayer } from "./layers/EdgeLayer";
import { FireLayer } from "./layers/FireLayer";
import { HeatmapLayer } from "./layers/HeatmapLayer";
import { PlacesLayer } from "./layers/PlacesLayer";
import { RecipientsLayer } from "./layers/RecipientsLayer";
import { RoutesLayer } from "./layers/RoutesLayer";
import { SitesLayer } from "./layers/SitesLayer";
import { SuppressionLayer } from "./layers/SuppressionLayer";
import { SurveyLayer } from "./layers/SurveyLayer";
import { ZonesLayer } from "./layers/ZonesLayer";
import { PhonePreviewTool, TestFireTool } from "./tools/ClickTools";
import { DrawZoneTool } from "./tools/DrawZoneTool";
import { EdgeEditTool } from "./tools/EdgeEditTool";
import { SelectTool } from "./tools/SelectTool";
import { ShelterEditTool } from "./tools/ShelterEditTool";

/** Everything drawn on the globe, bottom to top, plus the editing tools. */
export function GlobeLayers() {
  return (
    <>
      <CoverageLayer />
      <HeatmapLayer />
      <SurveyLayer />
      <FireLayer />
      <SuppressionLayer />
      <ZonesLayer />
      <PlacesLayer />
      <RoutesLayer />
      <RecipientsLayer />
      <EdgeLayer />
      <SitesLayer />
      <DronesLayer />
      <SelectTool />
      <DrawZoneTool />
      <EdgeEditTool />
      <ShelterEditTool />
      <TestFireTool />
      <PhonePreviewTool />
    </>
  );
}
