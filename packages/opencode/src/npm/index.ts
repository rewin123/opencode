import semver from "semver"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import { readdir, rm } from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@/util/flock"
import { Arborist } from "@npmcli/arborist"
import readline from "readline"

export namespace Npm {
  const log = Log.create({ service: "npm" })

  // Track user consent for external downloads within the current session
  const _consentCache = new Map<string, boolean>()

  async function requestDownloadConsent(pkg: string, source: string): Promise<boolean> {
    const key = `${source}:${pkg}`
    if (_consentCache.has(key)) return _consentCache.get(key)!

    // Non-interactive mode — deny by default
    if (!process.stdin.isTTY) {
      log.warn("external download blocked (non-interactive)", { pkg, source })
      return false
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `\n[DOWNLOAD CONSENT] opencode wants to download "${pkg}" from ${source}.\nAllow? (y/N): `,
        resolve,
      )
    })
    rl.close()
    const allowed = answer.trim().toLowerCase() === "y"
    _consentCache.set(key, allowed)
    if (!allowed) log.warn("external download denied by user", { pkg, source })
    return allowed
  }

  export const InstallFailedError = NamedError.create(
    "NpmInstallFailedError",
    z.object({
      pkg: z.string(),
    }),
  )

  function directory(pkg: string) {
    return path.join(Global.Path.cache, "packages", pkg)
  }

  function resolveEntryPoint(name: string, dir: string) {
    let entrypoint: string | undefined
    try {
      entrypoint = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
    } catch {}
    const result = {
      directory: dir,
      entrypoint,
    }
    return result
  }

  export async function outdated(pkg: string, cachedVersion: string): Promise<boolean> {
    if (!(await requestDownloadConsent(pkg, "registry.npmjs.org"))) return false
    const response = await fetch(`https://registry.npmjs.org/${pkg}`)
    if (!response.ok) {
      log.warn("Failed to resolve latest version, using cached", { pkg, cachedVersion })
      return false
    }

    const data = (await response.json()) as { "dist-tags"?: { latest?: string } }
    const latestVersion = data?.["dist-tags"]?.latest
    if (!latestVersion) {
      log.warn("No latest version found, using cached", { pkg, cachedVersion })
      return false
    }

    const range = /[\s^~*xX<>|=]/.test(cachedVersion)
    if (range) return !semver.satisfies(latestVersion, cachedVersion)

    return semver.lt(cachedVersion, latestVersion)
  }

  export async function add(pkg: string) {
    if (!(await requestDownloadConsent(pkg, "registry.npmjs.org"))) {
      throw new InstallFailedError({ pkg })
    }
    const dir = directory(pkg)
    await using _ = await Flock.acquire(`npm-install:${Filesystem.resolve(dir)}`)
    log.info("installing package", {
      pkg,
    })

    const arborist = new Arborist({
      path: dir,
      binLinks: true,
      progress: false,
      savePrefix: "",
    })
    const tree = await arborist.loadVirtual().catch(() => {})
    if (tree) {
      const first = tree.edgesOut.values().next().value?.to
      if (first) {
        return resolveEntryPoint(first.name, first.path)
      }
    }

    const result = await arborist
      .reify({
        add: [pkg],
        save: true,
        saveType: "prod",
      })
      .catch((cause) => {
        throw new InstallFailedError(
          { pkg },
          {
            cause,
          },
        )
      })

    const first = result.edgesOut.values().next().value?.to
    if (!first) throw new InstallFailedError({ pkg })
    return resolveEntryPoint(first.name, first.path)
  }

  export async function install(dir: string) {
    if (!(await requestDownloadConsent(dir, "registry.npmjs.org"))) return
    await using _ = await Flock.acquire(`npm-install:${dir}`)
    log.info("checking dependencies", { dir })

    const reify = async () => {
      const arb = new Arborist({
        path: dir,
        binLinks: true,
        progress: false,
        savePrefix: "",
      })
      await arb.reify().catch(() => {})
    }

    if (!(await Filesystem.exists(path.join(dir, "node_modules")))) {
      log.info("node_modules missing, reifying")
      await reify()
      return
    }

    const pkg = await Filesystem.readJson(path.join(dir, "package.json")).catch(() => ({}))
    const lock = await Filesystem.readJson(path.join(dir, "package-lock.json")).catch(() => ({}))

    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ])

    const root = lock.packages?.[""] || {}
    const locked = new Set([
      ...Object.keys(root.dependencies || {}),
      ...Object.keys(root.devDependencies || {}),
      ...Object.keys(root.peerDependencies || {}),
      ...Object.keys(root.optionalDependencies || {}),
    ])

    for (const name of declared) {
      if (!locked.has(name)) {
        log.info("dependency not in lock file, reifying", { name })
        await reify()
        return
      }
    }

    log.info("dependencies in sync")
  }

  export async function which(pkg: string) {
    const dir = directory(pkg)
    const binDir = path.join(dir, "node_modules", ".bin")
    // Check if already installed locally before triggering consent
    const existingBin = await readdir(binDir).catch(() => [])
    if (existingBin.length === 0) {
      if (!(await requestDownloadConsent(pkg, "registry.npmjs.org"))) return undefined
    }

    const pick = async () => {
      const files = await readdir(binDir).catch(() => [])
      if (files.length === 0) return undefined
      if (files.length === 1) return files[0]
      // Multiple binaries — resolve from package.json bin field like npx does
      const pkgJson = await Filesystem.readJson<{ bin?: string | Record<string, string> }>(
        path.join(dir, "node_modules", pkg, "package.json"),
      ).catch(() => undefined)
      if (pkgJson?.bin) {
        const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
        const bin = pkgJson.bin
        if (typeof bin === "string") return unscoped
        const keys = Object.keys(bin)
        if (keys.length === 1) return keys[0]
        return bin[unscoped] ? unscoped : keys[0]
      }
      return files[0]
    }

    const bin = await pick()
    if (bin) return path.join(binDir, bin)

    await rm(path.join(dir, "package-lock.json"), { force: true })
    await add(pkg)
    const resolved = await pick()
    if (!resolved) return
    return path.join(binDir, resolved)
  }
}
