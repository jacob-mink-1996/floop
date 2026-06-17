import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { createFloopServer } from "../services/api/src/app.mjs";
import { createStore } from "../services/api/src/store.mjs";

const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const fixtureDir = mkdtempSync(join(tmpdir(), "floop-react-ui-"));
mkdirSync(join(fixtureDir, "suggested-workspace"));
mkdirSync(join(fixtureDir, "suggested-workspace", "nested-child"));
const store = createStore({
  filename: join(fixtureDir, "floop.sqlite"),
  seedDemo: true,
  workspaceRoot: join(fixtureDir, "workspace"),
});
store.createAgentMessage("project_floop", {
  actor: "openclaw",
  source: "ui-check",
  intent: "suggest_ticket",
  target: { repoId: "repo_project_floop_floop" },
  summary: "Add fixture coverage for ceremony fan-out",
  body: "The ceremony participant path should be covered with a real adapter fixture.",
  metadata: { check: "browser" },
});
const server = createFloopServer({ store });
let driver;
let sessionId = "";
let driverBaseUrl = "";

try {
  await listen(server);
  const address = server.address();
  const appUrl = `http://127.0.0.1:${address.port}`;
  const driverPort = await freePort();
  driverBaseUrl = `http://127.0.0.1:${driverPort}`;
  driver = await launchChromeDriver(driverPort);
  sessionId = await createSession();

  await navigate(appUrl);
  await waitForText("Floop");
  await clickText("Board");
  await waitForScript("document.querySelectorAll('.ticket-card').length >= 2");
  await assertNoUiErrors();
  await assertScript("document.querySelector('.project-description') !== null", "project description is visible in the topbar");
  await assertScript("document.documentElement.dataset.theme === 'light'", "floop-day theme is the default");
  await clickText("Use deep-end theme");
  await waitForScript("document.documentElement.dataset.theme === 'dark'");
  await assertScript("getComputedStyle(document.body).backgroundColor !== 'rgb(246, 242, 232)'", "deep-end theme changes the page background");
  await navigate(appUrl);
  await waitForText("Floop");
  await waitForScript("document.documentElement.dataset.theme === 'dark'");
  await clickText("Use day theme");
  await waitForScript("document.documentElement.dataset.theme === 'light'");

  await clickText("New project");
  await waitForScript("document.querySelector('.onboarding-dialog') !== null");
  await selectWorkspaceSourceMode("new");
  await setFormValue("Create project", "newFolderPath", join(fixtureDir, "suggest"));
  await waitForText("suggested-workspace");
  await assertScript(
    "document.querySelector('input[name=\"name\"]')?.value === 'Suggest' && document.querySelector('input[name=\"slug\"]')?.value === 'suggest'",
    "project details derive from a typed folder stem",
  );
  await clickText("suggested-workspace");
  await assertScript(
    "document.querySelector('input[name=\"newFolderPath\"]')?.value.endsWith('/suggested-workspace/')",
    "clicking a folder suggestion appends a trailing slash",
  );
  await waitForText("nested-child");
  await selectWorkspaceSourceMode("clone");
  await setFormValue("Create project", "repoRemoteUrl", "git@github.com:acme/browser-onboarding.git");
  await assertScript(
    "document.querySelector('input[name=\"repoClonePath\"]')?.value === '~/src/browser-onboarding'",
    "clone destination defaults from the repo URL",
  );
  await selectWorkspaceSourceMode("new");
  await setFormValue("Create project", "name", "Browser Onboarding Project");
  await setFormValue("Create project", "slug", "browser-onboarding");
  await setFormValue("Create project", "newFolderPath", join(fixtureDir, "browser-onboarding"));
  await setFormValue("Create project", "defaultBaseBranch", "main");
  await setFormValue("Create project", "description", "Created from the React onboarding flow.");
  await clickText("Create project");
  await waitForText("Browser Onboarding Project");
  await assertScript("document.querySelector('.onboarding-dialog') === null", "onboarding closes after project creation");
  await clickText("Settings");
  await waitForScript("document.querySelector('.settings-drawer') !== null");
  await setFormValue("Delete project", "deleteConfirmation", "Browser Onboarding Project");
  await clickText("Delete project");
  await waitForScript("document.querySelector('.settings-drawer') === null");
  await waitForTextGone("Browser Onboarding Project");
  await clickText("Floop");
  await waitForText("Floop");
  await assertNoUiErrors();
  await transitionTicket(appUrl, "project_floop", "ticket_project_floop_2", "WORKING");
  await clickText("Board");
  await clickText("Refresh");
  await waitForScript(`
    Array.from(document.querySelectorAll(".lane")).some((lane) =>
      lane.querySelector(".lane-header h3")?.innerText.includes("Working") &&
      lane.innerText.includes("FLOOP-2")
    )
  `);
  await assertScript(`
    Array.from(document.querySelectorAll(".lane")).every((lane) => {
      const laneBottom = lane.getBoundingClientRect().bottom;
      return Array.from(lane.querySelectorAll(".ticket-card")).every((ticket) =>
        ticket.getBoundingClientRect().bottom <= laneBottom + 1
      );
    })
  `, "ticket cards stay inside their lane border");
  await assertScript(`
    (() => {
      const gridElement = document.querySelector(".board-grid");
      if (!gridElement) return false;
      const targetHeight = Math.max(gridElement.clientHeight, gridElement.scrollHeight);
      return Array.from(document.querySelectorAll(".lane")).every((lane) =>
        Math.abs(lane.getBoundingClientRect().height - targetHeight) <= 2
      );
    })()
  `, "swimlane dividers extend to the board bottom");

  await clickText("Ceremonies");
  await assertScript("document.querySelector('.constellation-stage') !== null", "ceremony orbit renders before a ceremony run");
  await assertScript("document.querySelector('.constellation-ring') !== null && document.querySelector('.decider-node') !== null", "ceremony constellation has an orbit and center decider");
  await assertScript("document.querySelectorAll('.agent-node').length >= 3", "ceremony constellation renders participant nodes");
  await assertScript("document.querySelectorAll('.consensus-cell').length >= 4", "ceremony consensus heatmap is visible");
  await clickText("Board");

  await clickText("Cockpit");
  await waitForText("Attention");
  await assertScript("document.body.innerText.includes('Add fixture coverage for ceremony fan-out')", "agent inbox suggestion renders in Cockpit attention");
  await clickText("Convert");
  await waitForScript("!document.body.innerText.includes('Add fixture coverage for ceremony fan-out')");
  await clickText("Board");

  await clickText("Settings");
  await waitForScript("document.querySelector('.settings-drawer') !== null");
  await assertScript("document.querySelectorAll('.toggle-list input[type=\"checkbox\"]').length >= 4", "settings policy checkboxes render");
  await assertScript("document.querySelector('select[name=\"interactionMode\"]') !== null", "settings interaction mode renders");
  await assertScript("document.querySelector('input[name=\"ceremonyAutomationEnabled\"]') !== null", "settings ceremony trigger controls render");
  await assertScript("getComputedStyle(document.querySelector('.toggle-list label')).borderStyle !== 'none'", "settings checkbox rows are styled");
  await setFormValue("Save project", "name", "Floop QA Control");
  await setFormValue("Save project", "description", "Browser-tested floop operations.");
  await clickText("Save project");
  await waitForText("Floop QA Control");
  await waitForText("Browser-tested floop operations.");
  await clickText("Show profiles");
  await setProfileConfig("developer", "{bad json");
  await clickProfileTest("developer");
  await waitForText("Config must be valid JSON");
  await clickProfilePreset("developer", "Shell");
  await setProfileConfig("developer", '{"command":"node --version"}');
  await clickProfileTest("developer");
  await waitForText("Profile test passed");
  await clickProfileSave("developer");

  await clickSelector(".settings-drawer .drawer-heading button");
  await waitForScript("document.querySelector('.settings-drawer') === null");

  await clickText("New Ticket");
  await waitForScript("document.querySelector('.ticket-composer') !== null");
  await setFormValue("Create ticket", "title", "Browser QA ticket");
  await setFormValue("Create ticket", "brief", "Exercise the React UI from Chromium.");
  await setFormValue("Create ticket", "repoId", "repo_project_floop_qa_repo");
  await clickText("Create ticket");
  await waitForText("Browser QA ticket");

  await waitForScript("document.querySelector('.ticket-detail') !== null");
  await waitForText("Start developer lane");
  await assertScript("document.querySelector('.ticket-detail .read-model') !== null", "ticket plan is read-only by default");
  await openDisclosure("Advanced");
  await waitForText("Danger Zone");
  await waitForText("Type FLOOP-4 to confirm");
  await assertScript("document.querySelector('[name=\"restartConfirmation\"]') !== null", "ticket restart confirmation is available");
  await assertScript("Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === 'Restart ticket' && button.disabled)", "restart button is disabled before exact ticket key confirmation");
  await assertScript("document.querySelector('.ticket-detail [name=\"latestSummary\"]') === null", "ticket edit fields are not mounted before edit mode");
  await assertScript("document.querySelector('.ticket-detail [name=\"blockingTicketId\"]') === null", "scope dependency controls are not mounted before edit mode");
  await assertScript("document.querySelector('.ticket-detail [name=\"repoId\"]') === null", "scope repo controls are not mounted before edit mode");
  await clickText("Edit ticket");
  await assertScript("document.querySelector('.ticket-detail [name=\"latestSummary\"]') !== null", "ticket edit fields mount after edit mode");
  await assertScript("document.querySelector('.ticket-detail [name=\"blockingTicketId\"]') !== null", "scope dependency controls mount after edit mode");
  await assertScript("document.querySelector('.ticket-detail [name=\"repoId\"]') !== null", "scope repo controls mount after edit mode");
  await setFormValue("Save", "title", "Browser QA ticket edited");
  await setFormValue("Save", "latestSummary", "Edited through browser automation.");
  await clickText("Save");
  await waitForText("Browser QA ticket edited");

  await clickText("Edit ticket");
  await openDisclosure("Scope");
  await setFirstSelectOption("Add blocker", "blockingTicketId");
  await clickText("Add blocker");
  await waitForScript("Array.from(document.querySelectorAll('article')).some((item) => item.innerText.includes('FLOOP-') && item.innerText.includes('finish_to_start'))");
  await clickButtonInArticle("finish_to_start", "Remove");
  await waitForScript("!Array.from(document.querySelectorAll('article')).some((item) => item.innerText.includes('finish_to_start'))");
  await clickText("Stop editing");

  await setFormValue("Dispatch agent", "summary", "Starting from the browser UI.");
  await clickText("Dispatch agent");
  await waitForText("CURRENT WORK");
  await transitionTicket(appUrl, "project_floop", "ticket_project_floop_4", "DONE");
  await clickText("Close ticket detail");
  await clickText("Refresh");
  await waitForText("Done");

  await assertNoUiErrors();
  await assertScript("document.body.scrollWidth <= window.innerWidth", "desktop body has no horizontal overflow");
  await assertScript("document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight", "desktop body does not own vertical scrolling");

  await setViewport(390, 844, true);
  await navigate(appUrl);
  await waitForText("Projects");
  await clickText("Board");
  await waitForText("Browser QA ticket edited");
  await assertScript("document.body.scrollWidth <= window.innerWidth", "mobile body has no horizontal overflow");
  await clickText("Projects");
  await waitForScript("document.querySelector('.project-rail.is-open') !== null");
  await clickSelector(".scrim");
  await waitForScript("document.querySelector('.project-rail.is-open') === null");
  await clickTicket("Browser QA ticket edited");
  await waitForScript("document.querySelector('.ticket-detail') !== null");
  await assertNoUiErrors();

  console.log("Floop React browser UI check");
  console.log("===========================");
  console.log("settings, composer, ticket detail, scope, action flow, and mobile drawers: ok");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
  }
  if (driver) {
    driver.kill("SIGTERM");
    await once(driver, "exit").catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}

async function listen(httpServer) {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launchChromeDriver(port) {
  const process = spawn("chromedriver", [`--port=${port}`], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  process.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetchJson(`${driverBaseUrl}/status`);
      return process;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`chromedriver did not become ready. ${stderr}`);
}

async function createSession() {
  const payload = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        "goog:chromeOptions": {
          binary: "/usr/bin/chromium",
          args: [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-background-networking",
            "--window-size=1440,1000",
            `--user-data-dir=${join(fixtureDir, "chromium")}`,
          ],
        },
      },
    },
  });
  return payload.sessionId || payload.value?.sessionId;
}

async function navigate(url) {
  await webdriver("POST", `/session/${sessionId}/url`, { url });
}

async function setViewport(width, height, mobile) {
  await execute(`
    window.resizeTo(arguments[0], arguments[1]);
    return true;
  `, [width, height]);
  await webdriver("POST", `/session/${sessionId}/goog/cdp/execute`, {
    cmd: "Emulation.setDeviceMetricsOverride",
    params: { width, height, deviceScaleFactor: 1, mobile },
  });
}

async function clickText(text) {
  const element = await elementFromScript(`
    const text = arguments[0];
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const label = [button.innerText, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
        return label.includes(text) && !button.disabled && rect.width > 0 && rect.height > 0;
      });
    return buttons.find((button) => [button.innerText, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).some((label) => label.trim() === text)) || buttons[0] || null;
  `, [text]);
  await clickElement(element);
}

async function selectWorkspaceSourceMode(value) {
  await execute(`
    const input = document.querySelector(\`input[name="workspaceSourceMode"][value="\${arguments[0]}"]\`);
    if (!input) return false;
    input.click();
    return true;
  `, [value]);
  await waitForScript(`
    document.querySelector('input[name="workspaceSourceMode"][value="${value}"]')?.checked === true
  `);
}

async function clickTicket(text) {
  const element = await findElement(`//button[contains(@class, 'ticket-card') and contains(normalize-space(.), ${xpathString(text)})]`);
  await clickElement(element);
}

async function dragTicketToLane(ticketText, laneText) {
  const rects = await execute(`
    const ticketText = arguments[0];
    const laneText = arguments[1];
    const board = document.querySelector(".board-grid");
    if (board) board.scrollLeft = 0;
    const ticket = Array.from(document.querySelectorAll(".ticket-card")).find((item) => item.innerText.includes(ticketText));
    const lane = Array.from(document.querySelectorAll(".lane")).find((item) =>
      item.querySelector(".lane-header h3")?.innerText.includes(laneText)
    );
    if (!ticket || !lane) return null;
    const target = lane.querySelector(".lane-body") || lane;
    const ticketRect = ticket.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      sx: Math.round(ticketRect.left + ticketRect.width / 2),
      sy: Math.round(ticketRect.top + Math.min(ticketRect.height / 2, 46)),
      ex: Math.round(targetRect.left + targetRect.width / 2),
      ey: Math.round(targetRect.top + Math.min(Math.max(targetRect.height / 2, 72), 160)),
    };
  `, [ticketText, laneText]);
  assert.ok(rects, `Unable to find drag source ${ticketText} and lane ${laneText}`);
  await dispatchMouse("mouseMoved", rects.sx, rects.sy);
  await dispatchMouse("mousePressed", rects.sx, rects.sy);
  await delay(120);
  for (let step = 1; step <= 6; step += 1) {
    const x = Math.round(rects.sx + ((rects.ex - rects.sx) * step) / 6);
    const y = Math.round(rects.sy + ((rects.ey - rects.sy) * step) / 6);
    await dispatchMouse("mouseMoved", x, y);
    await delay(40);
  }
  await dispatchMouse("mouseReleased", rects.ex, rects.ey);
}

async function dispatchMouse(type, x, y) {
  await webdriver("POST", `/session/${sessionId}/goog/cdp/execute`, {
    cmd: "Input.dispatchMouseEvent",
    params: { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1 },
  });
}

async function clickSelector(selector) {
  const element = await elementFromScript("return document.querySelector(arguments[0]);", [selector]);
  await clickElement(element);
}

async function clickProfileSave(role) {
  const element = await elementFromScript(`
    const role = arguments[0];
    const card = document.querySelector(\`.profile-card[data-role="\${role}"]\`);
    const field = card?.querySelector('textarea[name="config"]') || document.querySelector('textarea[name="config"]');
    return field?.closest("form")?.querySelector('button[type="submit"]') || null;
  `, [role]);
  await clickElement(element);
}

async function clickProfileTest(role) {
  const element = await elementFromScript(`
    const role = arguments[0];
    const card = document.querySelector(\`.profile-card[data-role="\${role}"]\`);
    const form = card || document.querySelector('textarea[name="config"]')?.closest("form");
    if (!form) return null;
    form.scrollIntoView({ block: "center", inline: "center" });
    return Array.from(form.querySelectorAll("button")).find((button) => button.innerText.includes("Test profile")) || null;
  `, [role]);
  await clickElement(element);
}

async function clickProfilePreset(role, label) {
  const element = await elementFromScript(`
    const role = arguments[0];
    const label = arguments[1];
    const card = document.querySelector(\`.profile-card[data-role="\${role}"]\`);
    if (!card) return null;
    card.scrollIntoView({ block: "center", inline: "center" });
    return Array.from(card.querySelectorAll("button")).find((button) => button.innerText.trim() === label) || null;
  `, [role, label]);
  await clickElement(element);
}

async function clickButtonInArticle(articleText, buttonText) {
  const element = await elementFromScript(`
    const articleText = arguments[0];
    const buttonText = arguments[1];
    const article = Array.from(document.querySelectorAll("article")).find((item) => item.innerText.includes(articleText));
    return article ? Array.from(article.querySelectorAll("button")).find((button) => {
      const label = [button.innerText, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
      return label.includes(buttonText);
    }) : null;
  `, [articleText, buttonText]);
  await clickElement(element);
}

async function openDisclosure(summaryText) {
  const expected = JSON.stringify(summaryText);
  await assertScript(`
    (() => {
      const expected = ${expected};
      const summary = Array.from(document.querySelectorAll("summary")).find((item) => item.innerText.includes(expected));
      if (!summary) return false;
      summary.closest("details").open = true;
      return true;
    })()
  `, `${summaryText} disclosure opens`);
}

async function transitionTicket(appUrl, projectId, ticketId, targetState) {
  const response = await fetch(`${appUrl}/api/v1/projects/${projectId}/tickets/${ticketId}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetState,
      reason: "Browser verifier board move coverage.",
      reasonCode: "browser_verifier_transition",
    }),
  });
  assert.equal(response.ok, true, await response.text());
}

async function setFormValue(submitText, fieldName, value) {
  const ok = await execute(`
    const submitText = arguments[0];
    const fieldName = arguments[1];
    const value = arguments[2];
    const form = Array.from(document.querySelectorAll("form"))
      .find((item) => Array.from(item.querySelectorAll("button")).some((button) => {
        const label = [button.innerText, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
        return label.includes(submitText);
      }));
    if (!form) return false;
    const field = form.elements[fieldName];
    if (!field) return false;
    const target = field instanceof RadioNodeList ? field[0] : field;
    target.scrollIntoView({ block: "center", inline: "center" });
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value");
    if (descriptor?.set) {
      descriptor.set.call(target, value);
    } else {
      target.value = value;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [submitText, fieldName, value]);
  assert.equal(ok, true, `Unable to set ${fieldName} in ${submitText}`);
}

async function setFirstSelectOption(submitText, fieldName) {
  const ok = await execute(`
    const submitText = arguments[0];
    const fieldName = arguments[1];
    const form = Array.from(document.querySelectorAll("form"))
      .find((item) => Array.from(item.querySelectorAll("button")).some((button) => {
        const label = [button.innerText, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
        return label.includes(submitText);
      }));
    const field = form?.elements[fieldName];
    if (!field || field.options.length === 0) return false;
    field.value = field.options[0].value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [submitText, fieldName]);
  assert.equal(ok, true, `Unable to set first option for ${fieldName} in ${submitText}`);
}

async function setProfileConfig(role, value) {
  const ok = await execute(`
    const role = arguments[0];
    const value = arguments[1];
    const card = document.querySelector(\`.profile-card[data-role="\${role}"]\`);
    const field = card ? card.querySelector('textarea[name="config"]') : null;
    if (!field) return false;
    field.scrollIntoView({ block: "center", inline: "center" });
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
    if (descriptor?.set) {
      descriptor.set.call(field, value);
    } else {
      field.value = value;
    }
    field._valueTracker?.setValue("");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [role, value]);
  assert.equal(ok, true, `Unable to set profile config for ${role}`);
}

async function waitForProfileConfig(role, value) {
  await waitForScript(
    `
      const field = document.querySelector(\`.profile-card[data-role="\${arguments[0]}"] textarea[name="config"]\`);
      if (!field) return false;
      try {
        return JSON.stringify(JSON.parse(field.value)) === JSON.stringify(JSON.parse(arguments[1]));
      } catch {
        return field.value === arguments[1];
      }
    `,
    [role, value],
  );
}

async function assertNoUiErrors() {
  const text = await execute(`
    return Array.from(document.querySelectorAll(".status.is-error, .field-error")).map((item) => item.innerText).join("\\n");
  `);
  assert.equal(text, "", text);
}

async function waitForText(text, timeoutMs = 5000) {
  await waitForScript("document.body && document.body.innerText.includes(arguments[0])", [text], timeoutMs);
}

async function waitForTextGone(text, timeoutMs = 5000) {
  await waitForScript("document.body && !document.body.innerText.includes(arguments[0])", [text], timeoutMs);
}

async function waitForScript(script, args = [], timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await execute(`return Boolean(${script});`, args).catch(() => false)) {
      return;
    }
    await delay(80);
  }
  const text = await execute("return document.body?.innerText || ''").catch(() => "");
  throw new Error(`Timed out waiting for: ${script}\n\nPage text:\n${text.slice(0, 2000)}`);
}

async function assertScript(script, message) {
  assert.equal(await execute(`return Boolean(${script});`), true, message);
}

async function findElement(xpath) {
  const payload = await webdriver("POST", `/session/${sessionId}/element`, {
    using: "xpath",
    value: xpath,
  });
  return payload.value;
}

async function elementFromScript(script, args = []) {
  const element = await execute(script, args);
  assert.ok(element, "Expected script to return an element");
  return element;
}

async function clickElement(element) {
  await webdriver("POST", `/session/${sessionId}/element/${elementId(element)}/click`, {});
}

function elementId(element) {
  return element[elementKey] || element.ELEMENT;
}

async function execute(script, args = []) {
  const payload = await webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
  return payload.value;
}

async function webdriver(method, path, body) {
  return fetchJson(`${driverBaseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message || `${response.status} ${response.statusText}`);
  }
  return Object.hasOwn(payload, "value") ? payload : { value: payload };
}

function xpathString(value) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `concat('${value.split("'").join("', \"'\", '")}')`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
