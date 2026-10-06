import { ToolRegistry } from "@/lib/ai/tools/registry";
import { getSyncStatusTool } from "@/lib/ai/tools/status";
import { getSearchPagesTool, getSearchPerformanceTool, getSearchQueriesTool } from "@/lib/ai/tools/gsc";

let registry: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
  if (!registry) {
    registry = new ToolRegistry().register(getSyncStatusTool).register(getSearchPerformanceTool).register(getSearchQueriesTool).register(getSearchPagesTool);
  }
  return registry;
}
