import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "Basics",
  version: packageJson.version,
  copyright: `© ${currentYear}, Basics.`,
  meta: {
    title: "Basics",
    description:
      "Run B2B SaaS RevOps playbooks in cloud Chrome with live-view, take-over, approval gating, and audit log.",
  },
};
