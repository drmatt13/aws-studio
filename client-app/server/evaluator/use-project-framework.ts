import { useProjectFramework } from "./project-framework";

/**
 * Imported first by every Studio process that loads a project's framework.config.ts, before any
 * module that imports aws-studio: from here on, the framework is the project's.
 */
useProjectFramework(process.env.STUDIO_REPOSITORY_ROOT ?? process.cwd());
