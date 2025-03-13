#!/usr/bin/env node

import async from "async";
import { Command } from "commander";
import Bottleneck from "bottleneck";
import colors from "colors";
import crypto from "crypto";
import inquirer from "inquirer";
import sanitizeFilename from "sanitize-filename";
import url from "url";
import util from "util";
import path from "path";
import * as fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import puppeteer from "puppeteer";
import { Readable } from "stream";

let options = {};
const packageInfo = await loadPackageInfo();
const userAgent = util.format(
  "Humblebundle-Ebook-Downloader/%s",
  packageInfo.version,
);

const SUPPORTED_FORMATS = [
  "epub",
  "mobi",
  "pdf",
  "pdf_hd",
  "prc",
  "cbz",
  "zip",
  "txt",
  "csv",
  "iso",
];
const ALLOWED_FORMATS = SUPPORTED_FORMATS.concat(["all"]).sort();

const configPath = await getConfigPath();
const commander = new Command();

const downloadErrors = [];

async function loadPackageInfo() {
  try {
    const data = await fs.readFile("./package.json", "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error loading package.json:", error);
    return {}; // Or handle the error appropriately
  }
}

async function getConfigPath() {
  let configPath = path.resolve(
    os.homedir(),
    ".humblebundle_ebook_downloader.json",
  );

  try {
    await fs.access(configPath);
    return configPath; // File exists in home directory
  } catch (homeDirError) {
    configPath = path.resolve(
      process.cwd(),
      ".humblebundle_ebook_downloader.json",
    );
    try {
      await fs.access(configPath);
      return configPath; // File exists in current working directory
    } catch (cwdError) {
      return null; // File does not exist in either location
    }
  }
}

async function loadConfig() {
  try {
    await fs.access(configPath);
    const data = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(data);
    options = config ?? {};
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(error);
  }
}

function getRequestHeaders(session) {
  const headers = new Headers();
  headers.append("Accept", "application/json");
  headers.append("Accept-Charset", "utf-8");
  headers.append("User-Agent", userAgent);
  headers.append("Cookie", "_simpleauth_sess=" + session + ";");

  return headers;
}

async function validateSession(config) {
  console.log("Validating session...");

  var session = config.session;

  if (!options.authToken) {
    if (!config.session || !config.expirationDate) {
      throw new Error("No session and/or expirationDate in config");
    }

    if (config.expirationDate < new Date()) {
      throw new Error("expirationDate is in the past");
    }
  } else {
    session = util.format('"%s"', commander.authToken.replace(/^"|"$/g, ""));
  }

  try {
    const headers = getRequestHeaders(session);
    const response = await fetch(
      "https://www.humblebundle.com/api/v1/user/order?ajax=true",
      {
        method: "GET",
        headers,
      },
    );
    const data = await response.json();

    if (!data) {
      throw new Error(
        util.format("No data returned, could not validate session"),
      );
    }

    if (response.status === 200) {
      return session;
    }

    if (response.status === 401 && !options.authToken) {
      throw new Error(util.format("Unauthorized (401) - no authToken"));
    }

    throw new Error(
      util.format(
        "Could not validate session, unknown error, status code:",
        response.status,
      ),
    );
  } catch (e) {
    throw e;
  }
}

async function saveConfig(config) {
  return fs.writeFile(configPath, JSON.stringify(config, null, 4), "utf8");
}

async function handleRedirect(page, browser, saveConfig, targetUrl) {
  const parsedUrl = url.parse(targetUrl, true);

  if (
    parsedUrl.hostname !== "www.humblebundle.com" ||
    parsedUrl.pathname.indexOf("/home/library") === -1
  ) {
    return false; // Indicate no redirect handled
  }

  console.debug(`Handled redirect for url ${targetUrl}`);

  try {
    const cookies = await page.cookies("https://www.humblebundle.com");
    const sessionCookie = cookies.find(
      (cookie) => cookie.name === "_simpleauth_sess",
    );

    if (!sessionCookie) {
      throw new Error("Could not get session cookie");
    }

    await browser.close();

    return new Promise(async (resolve, reject) => {
      try {
        await saveConfig({
          session: sessionCookie.value,
          expirationDate: new Date(sessionCookie.expires * 1000),
        });
      } catch (e) {
        reject(error);
      }
      resolve(sessionCookie.value);
    });
  } catch (error) {
    throw error;
  }
}

async function authenticate(saveConfig) {
  console.log("Authenticating...");

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 800, height: 600 },
  });
  const page = await browser.newPage();

  await page.setUserAgent(userAgent);

  try {
    page.on("response", async (response) => {
      if (response.status() >= 300 && response.status() < 400) {
        const targetUrl = response.headers().location;
        if (targetUrl) {
          await handleRedirect(page, browser, saveConfig, targetUrl);
        }
      }
    });

    page.on("framenavigated", async (frame) => {
      if (frame === page.mainFrame()) {
        await handleRedirect(page, browser, saveConfig, frame.url());
      }
    });

    await page.goto(
      "https://www.humblebundle.com/login?goto=%2Fhome%2Flibrary",
    );
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function fetchOrders(session) {
  console.log("Fetching bundles...");

  try {
    const response = await fetch(
      "https://www.humblebundle.com/api/v1/user/order?ajax=true",
      {
        headers: getRequestHeaders(session),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Could not fetch orders, unknown error, status code: ${response.status}`,
      );
    }

    const ordersData = await response.json();
    const total = ordersData.length;
    let done = 0;

    const orderInfoLimiter = new Bottleneck({
      maxConcurrent: 5,
      minTime: 500,
    });

    const detailedOrders = await async.concat(ordersData, async (item) => {
      return orderInfoLimiter.schedule(async () => {
        const orderResponse = await fetch(
          `https://www.humblebundle.com/api/v1/order/${item.gamekey}?ajax=true`,
          {
            headers: getRequestHeaders(session),
          },
        );

        if (!orderResponse.ok) {
          throw new Error(
            `Could not fetch orders, unknown error, status code: ${orderResponse.status}`,
          );
        }

        const orderDetails = await orderResponse.json();
        console.log(
          "Fetched bundle information... (%s/%s)",
          colors.yellow(++done),
          colors.yellow(total),
        );
        return orderDetails;
      });
    });

    const filteredOrders = detailedOrders.filter((order) => {
      const platforms =
        order?.subproducts?.flatMap(
          (subproduct) =>
            subproduct?.downloads?.map((download) => download?.platform) ?? [],
        ) ?? [];
      return flatten(platforms).includes("ebook");
    });

    return filteredOrders;
  } catch (error) {
    throw error;
  }
}

function getWindowHeight() {
  var windowSize = process.stdout.getWindowSize();
  return windowSize[windowSize.length - 1];
}

async function displayOrders(orders) {
  const options = orders.map((order) => order.product.human_name);

  options.sort((a, b) => a.localeCompare(b));

  process.stdout.write("\x1Bc"); // Clear console

  const answers = await inquirer.prompt({
    type: "checkbox",
    name: "bundle",
    message: "Select bundles to download",
    choices: options,
    pageSize: getWindowHeight() - 2,
  });

  return orders.filter((item) =>
    answers.bundle.includes(item.product.human_name),
  );
}

function sortBundles(bundles) {
  return bundles.sort((a, b) => {
    return a.product.human_name.localeCompare(b.product.human_name);
  });
}

function flatten(list) {
  return list.reduce((a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), []);
}

async function ensureFolderCreated(downloadPath) {
  return fs.mkdir(downloadPath, { recursive: true });
}

function normalizeFormat(format) {
  switch (format.toLowerCase()) {
    case ".cbz":
      return "cbz";
    case "pdf (hq)":
    case "pdf (hd)":
      return "pdf_hd";
    case "download":
      return "pdf";
    default:
      return format.toLowerCase();
  }
}

function getExtension(format) {
  switch (format.toLowerCase()) {
    case "pdf_hd":
      return " (hd).pdf";
    default:
      return util.format(".%s", format);
  }
}

async function checkSignatureMatch(filePath, download) {
  try {
    await fs.access(filePath);

    const hashType = download.sha1 ? "sha1" : "md5";
    const hashToVerify = download[hashType];

    const hash = crypto.createHash(hashType);
    hash.setEncoding("hex");

    const stream = await fsSync.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on("error", reject);

      stream.on("end", () => {
        hash.end();
        resolve(hash.read() === hashToVerify);
      });

      stream.pipe(hash);
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return false; // File doesn't exist, so no match
    }
    throw error;
  }
}

async function downloadFile(response, filePath) {
  return new Promise((resolve, reject) => {
    const fileStream = fsSync.createWriteStream(filePath);
    const nodeStream = Readable.fromWeb(response.body); // Convert Web ReadableStream to Node.js Readable

    nodeStream.pipe(fileStream);

    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    nodeStream.on("error", reject);
  });
}

async function handleFileDownloadError(download, filePath, response) {
  downloadErrors.push({
    webUrl: download.url.web,
    filePath,
    status: response.status,
    statusText: response.statusText,
  });
  // Fail gracefully if possible documenting the failure case
  console.error(
    `Failed to download ${download.url.web}: ${response.status} ${response.statusText}`,
  );
  // Attempt to delete the file, even if there is an error.
  await fs.unlink(filePath);
}

async function downloadBook(bundle, name, download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(bundle),
  );

  await ensureFolderCreated(downloadPath);

  const fileName = util.format(
    "%s%s",
    name.trim(),
    getExtension(normalizeFormat(download.name)),
  );
  const filePath = path.resolve(downloadPath, sanitizeFilename(fileName));

  const matches = await checkSignatureMatch(filePath, download);

  if (matches) {
    return true; // Indicates download already exists
  }

  try {
    const response = await fetch(download.url.web);

    if (!response.ok) {
      await handleFileDownloadError(download, filePath, response);
    }

    await downloadFile(response, filePath);
    return;
  } catch (error) {
    await handleFileDownloadError(download, filePath, response);
    throw error;
  }
}

async function downloadBundles(bundles, config) {
  if (!bundles.length) {
    console.log(colors.green("No bundles selected, exiting"));
    return;
  }

  const downloads = [];

  for (const bundle of bundles) {
    const bundleName = bundle.product.human_name;
    const bundleDownloads = [];
    const bundleFormats = [];

    for (const subproduct of bundle.subproducts) {
      const filteredDownloads = subproduct.downloads.filter((download) => {
        return download.platform === "ebook";
      });

      const downloadStructs = filteredDownloads.flatMap(
        (download) => download?.download_struct ?? [],
      );

      const filteredDownloadStructs = downloadStructs.filter((download) => {
        if (!download?.name || !download?.url) {
          return false;
        }

        const normalizedFormat = normalizeFormat(download.name);

        if (
          !bundleFormats.includes(normalizedFormat) &&
          SUPPORTED_FORMATS.includes(normalizedFormat)
        ) {
          bundleFormats.push(normalizedFormat);
        }

        return options.format === "all" || normalizedFormat === options.format;
      });

      for (const filteredDownload of filteredDownloadStructs) {
        bundleDownloads.push({
          bundle: bundleName,
          download: filteredDownload,
          name: subproduct.human_name,
        });
      }
    }

    if (!bundleDownloads.length) {
      console.log(
        colors.red(
          "No downloads found matching the right format (%s) for bundle (%s), available formats: (%s)",
        ),
        options.format,
        bundleName,
        bundleFormats.sort().join(", "),
      );
      continue;
    }

    downloads.push(...bundleDownloads);
  }

  if (!downloads.length) {
    console.log(
      colors.red("No downloads found matching the right format (%s), exiting"),
      options.format,
    );
    return;
  }

  const limiter = new Bottleneck({
    // Limit concurrent downloads
    maxConcurrent: options.downloadLimit,
  });

  await async.each(downloads, async (download) => {
    await limiter.schedule(async () => {
      console.log(
        "Downloading %s - %s (%s) (%s)... (%s/%s)",
        download.bundle,
        download.name,
        download.download.name,
        download.download.human_size,
        colors.yellow(downloads.indexOf(download) + 1),
        colors.yellow(downloads.length),
      );

      const skipped = await downloadBook(
        download.bundle,
        download.name,
        download.download,
      );

      if (skipped) {
        console.log(
          "Skipped downloading of %s - %s (%s) (%s) - already exists... (%s/%s)",
          download.bundle,
          download.name,
          download.download.name,
          download.download.human_size,
          colors.yellow(downloads.indexOf(download) + 1),
          colors.yellow(downloads.length),
        );
      }
    });
  });

  console.log(colors.green("Done"));
}

async function main() {
  try {
    let config = await loadConfig();
    console.log(options);
    if (ALLOWED_FORMATS.indexOf(commander.format ?? options.format) === -1) {
      console.error(colors.red("Invalid format provided."));
      commander.help();
      return;
    }

    console.log(colors.green("Starting..."));

    commander
      .version(packageInfo.version)
      .option(
        "-d, --download-folder <downloader_folder>",
        "Download folder",
        config.downloadFolder ?? "download",
      )
      .option(
        "-l, --download-limit <download_limit>",
        "Parallel download limit",
        config.downloadLimit ?? 1,
      )
      .option(
        "-f, --format <format>",
        util.format(
          "What format to download the ebook in (%s)",
          ALLOWED_FORMATS.join(", "),
        ),
        config.format ?? "epub",
      )
      .option(
        "--auth-token <auth-token>",
        "Optional: If you want to run headless, you can specify your authentication cookie from your browser (_simpleauth_sess)",
      )
      .option("-a, --all", "Download all bundles")
      .option("--debug", "Enable debug logging", false)
      .parse(process.argv);

    if (config.debug ?? commander.debug) {
      console.log(config, options, commander.opts(), {
        ...config,
        ...commander.opts(),
      });
    }
    options = { ...options, ...config, ...commander.opts() };

    if (ALLOWED_FORMATS.indexOf(options.format) === -1) {
      console.error(colors.red("Invalid format selected."));
      commander.help();
    }

    let session = await validateSession(config);

    if (!session) {
      session = await authenticate(saveConfig);
    }

    const orders = await fetchOrders(session);
    const bundles = commander.all
      ? sortBundles(orders)
      : await displayOrders(orders);
    await downloadBundles(bundles, config);

    if (downloadErrors.length > 0) {
      console.warn(
        colors.red(
          `Download Errors:\n${downloadErrors.map((de) => JSON.stringify(de)).join("\n")}`,
        ),
      );
    } else {
      console.log(colors.green("Program completed successfully."));
    }
  } catch (error) {
    console.error(colors.red("An error occurred, exiting."));
    console.error(error);
    process.exit(1);
  }
}

main(); // Start the main execution
