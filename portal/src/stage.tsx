// The stage of the app a page is about (PHASE5-PLAN D5), so every command line it shows
// names that stage: `sealeye logs notes --stage sit` on sit's page, and no flag on dev's,
// whose commands are as they were.
import { createContext, useContext } from "react";
import { FIRST_STAGE } from "../../core/stages.js";

export const StageContext = createContext<string>(FIRST_STAGE);

/**
 * The flags a command line needs to reach this page's stage: none at dev, nor for a
 * deployment id, which names exactly one record whatever its stage.
 */
export function useStageFlags(target?: string): string[] {
  const stage = useContext(StageContext);
  if (!target || stage === FIRST_STAGE || /^dep_[0-9a-f]+$/.test(target)) return [];
  return ["--stage", stage];
}
