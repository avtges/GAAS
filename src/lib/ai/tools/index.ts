import { ToolRegistry } from "@/lib/ai/tools/registry";
import { getSyncStatusTool } from "@/lib/ai/tools/status";
import { getSearchPagesTool, getSearchPerformanceTool, getSearchQueriesTool } from "@/lib/ai/tools/gsc";
import { getAdsAdGroupPerformanceTool, getAdsCampaignPerformanceTool, getAdsKeywordPerformanceTool, getAdsSearchTermsTool } from "@/lib/ai/tools/ads";
import { compareChannelsTool, compareDateRangesTool } from "@/lib/ai/tools/compare";
import { getGa4AcquisitionTool, getGa4BusinessConversionsTool, getGa4DevicesTool, getGa4LandingPagesTool } from "@/lib/ai/tools/ga4";

let registry: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
  if (!registry) {
    registry = new ToolRegistry().register(getSyncStatusTool).register(getSearchPerformanceTool).register(getSearchQueriesTool).register(getSearchPagesTool)
      .register(getGa4AcquisitionTool)
      .register(getGa4LandingPagesTool)
      .register(getGa4DevicesTool)
      .register(getGa4BusinessConversionsTool)
      .register(getAdsCampaignPerformanceTool)
      .register(getAdsAdGroupPerformanceTool)
      .register(getAdsKeywordPerformanceTool)
      .register(getAdsSearchTermsTool)
      .register(compareDateRangesTool)
      .register(compareChannelsTool);
  }
  return registry;
}
