const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const {
  createDesktopEnvironment,
  findRepoRoot,
  resolveHost,
  resolvePort,
  waitForHealth,
} = require("./runtime.cjs");

let apiServer;
let executionDriver;
let mergeDriver;
let ceremonyAutomationDriver;
let ceremonyParticipantDriver;
let mainWindow;

async function startFloopApi(repoRoot) {
  const hasExplicitPort = Boolean(process.env.FLOOP_PORT);
  const desktopEnv = createDesktopEnvironment({
    userDataPath: app.getPath("userData"),
  });
  Object.assign(process.env, desktopEnv);

  const [
    { createFloopServer },
    { createExecutionDriver },
    { createMergeDriver },
    { createCeremonyAutomationDriver },
    { createCeremonyParticipantDriver },
    { createStore },
  ] =
    await Promise.all([
      import(pathToFileURL(path.join(repoRoot, "services/api/src/app.mjs")).href),
      import(pathToFileURL(path.join(repoRoot, "services/api/src/execution-driver.mjs")).href),
      import(pathToFileURL(path.join(repoRoot, "services/api/src/merge-driver.mjs")).href),
      import(pathToFileURL(path.join(repoRoot, "services/api/src/ceremony-automation-driver.mjs")).href),
      import(pathToFileURL(path.join(repoRoot, "services/api/src/ceremony-participant-driver.mjs")).href),
      import(pathToFileURL(path.join(repoRoot, "services/api/src/store.mjs")).href),
    ]);

  const host = resolveHost(desktopEnv.FLOOP_HOST);
  const port = resolvePort(desktopEnv.FLOOP_PORT);
  const store = createStore();
  executionDriver = createExecutionDriver({
    store,
    pollIntervalMs: Number.parseInt(process.env.FLOOP_EXECUTION_POLL_MS || "2000", 10),
  });
  mergeDriver = createMergeDriver({
    store,
    pollIntervalMs: Number.parseInt(process.env.FLOOP_MERGE_POLL_MS || "2000", 10),
  });
  ceremonyAutomationDriver = createCeremonyAutomationDriver({
    store,
    pollIntervalMs: Number.parseInt(process.env.FLOOP_CEREMONY_POLL_MS || "30000", 10),
  });
  ceremonyParticipantDriver = createCeremonyParticipantDriver({
    store,
    pollIntervalMs: Number.parseInt(process.env.FLOOP_CEREMONY_PARTICIPANT_POLL_MS || "2000", 10),
    maxParallel: Number.parseInt(process.env.FLOOP_CEREMONY_PARTICIPANT_MAX_PARALLEL || "4", 10),
  });
  apiServer = createFloopServer({ store, host, port, executionDriver });

  executionDriver.start();
  mergeDriver.start();
  ceremonyAutomationDriver.start();
  ceremonyParticipantDriver.start();

  const actualPort = await listenWithFallback(apiServer, {
    host,
    port,
    allowFallback: !hasExplicitPort,
  });
  process.env.FLOOP_PORT = String(actualPort);
  await waitForHealth({ host, port: actualPort });
  console.log(`Floop desktop API listening on http://${host}:${actualPort}`);

  return { host, port: actualPort };
}

function listenWithFallback(server, { host, port, allowFallback }) {
  return new Promise((resolve, reject) => {
    const listen = (nextPort) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (allowFallback && nextPort !== 0 && error.code === "EADDRINUSE") {
          listen(0);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : nextPort);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(nextPort, host);
    };

    listen(port);
  });
}

function createMainWindow({ host, port }) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    title: "Floop",
    backgroundColor: "#f6f7f9",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const nextUrl = new URL(url);
      if (nextUrl.origin === `http://${host}:${port}`) {
        return;
      }
      event.preventDefault();
      shell.openExternal(url);
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  mainWindow.loadURL(`http://${host}:${port}/`);
}

async function stopFloopApi() {
  await Promise.allSettled([
    executionDriver?.stop(),
    mergeDriver?.stop(),
    ceremonyAutomationDriver?.stop(),
    ceremonyParticipantDriver?.stop(),
    apiServer
      ? new Promise((resolve) => {
          apiServer.close(resolve);
        })
      : undefined,
  ]);
  apiServer = undefined;
  executionDriver = undefined;
  mergeDriver = undefined;
  ceremonyAutomationDriver = undefined;
  ceremonyParticipantDriver = undefined;
}

function installMenu() {
  const template = [
    {
      label: "Floop",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installIpcHandlers() {
  ipcMain.handle("floop:pick-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
}

app.whenReady()
  .then(async () => {
    installMenu();
    installIpcHandlers();
    const repoRoot = findRepoRoot(__dirname);
    const api = await startFloopApi(repoRoot);
    createMainWindow(api);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(api);
      }
    });
  })
  .catch((error) => {
    console.error("Floop desktop failed to start", error);
    dialog.showErrorBox(
      "Floop failed to start",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });

app.on("before-quit", (event) => {
  if (!apiServer) {
    return;
  }
  event.preventDefault();
  stopFloopApi()
    .catch((error) => {
      console.error("Failed to stop Floop API cleanly", error);
    })
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
