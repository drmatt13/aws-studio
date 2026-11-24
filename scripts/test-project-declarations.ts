import type { FrameworkDefaults, FrameworkNetwork } from "aws-studio/config";
import { testProjectModule } from "./test-project";

export const { defaults } = testProjectModule<{ defaults: FrameworkDefaults }>("framework-config/defaults");
export const { applicationVpc } = testProjectModule<{ applicationVpc: FrameworkNetwork }>("framework-config/networks/application");
