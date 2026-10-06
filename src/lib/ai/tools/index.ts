import { ToolRegistry } from "@/lib/ai/tools/registry";
import { getSyncStatusTool } from "@/lib/ai/tools/status";
import { getSearchPagesTool, getSearchPerformanceTool, getSearchQueriesTool } from "@/lib/ai/tools/gsc";
import { getGa4AcquisitionTool, getGa4BusinessConversionsTool, getGa4DevicesTool, getGa4LandingPagesTool } from "@/lib/ai/tools/ga4";

let registry: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
  if (!registry) {
    registry = new ToolRegistry().register(getSyncStatusTool).register(getSearchPerformanceTool).register(getSearchQueriesTool).register(getSearchPagesTool)
      .register(getGa4AcquisitionTool)
      .register(getGa4LandingPagesTool)
      .register(getGa4DevicesTool)
      .register(getGa4BusinessConversionsTool);
  }
  return registry;
}
