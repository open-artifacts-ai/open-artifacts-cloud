// Loaded by the laptop fixture CLI from the provisioning workspace.
export async function launchFixtureBrowser() {
  const { chromium } = await import("@playwright/test");
  return chromium.launch();
}
