import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const ENABLE_PROCESSED_INPUT = 0x0001
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Enable Virtual Terminal (VT) sequence processing on Windows.
 *
 * On Windows Server 2016 and some Windows 10 builds, the legacy conhost.exe
 * does not enable ENABLE_VIRTUAL_TERMINAL_INPUT by default. Without it,
 * special keys (arrows, Enter, Escape, etc.) are delivered as Windows Console
 * Input Records instead of VT/ANSI escape sequences, which breaks TUI
 * frameworks that expect VT input.
 *
 * This also enables ENABLE_VIRTUAL_TERMINAL_PROCESSING on stdout so the
 * console interprets ANSI escape codes for rendering.
 */
export function win32EnableVTMode() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const buf = new Uint32Array(1)

  // Enable VT input sequences on stdin
  const stdinHandle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  if (k32!.symbols.GetConsoleMode(stdinHandle, ptr(buf)) !== 0) {
    const mode = buf[0]!
    if ((mode & ENABLE_VIRTUAL_TERMINAL_INPUT) === 0) {
      k32!.symbols.SetConsoleMode(stdinHandle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT)
    }
  }

  // Enable VT output processing on stdout
  const stdoutHandle = k32!.symbols.GetStdHandle(STD_OUTPUT_HANDLE)
  if (k32!.symbols.GetConsoleMode(stdoutHandle, ptr(buf)) !== 0) {
    const mode = buf[0]!
    if ((mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) === 0) {
      k32!.symbols.SetConsoleMode(stdoutHandle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    }
  }
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as any
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    let mode = buf[0]!
    let changed = false
    // Clear ENABLE_PROCESSED_INPUT to prevent Ctrl+C from becoming CTRL_C_EVENT
    if (mode & ENABLE_PROCESSED_INPUT) {
      mode &= ~ENABLE_PROCESSED_INPUT
      changed = true
    }
    // Ensure ENABLE_VIRTUAL_TERMINAL_INPUT stays on (Server 2016 compat)
    if ((mode & ENABLE_VIRTUAL_TERMINAL_INPUT) === 0) {
      mode |= ENABLE_VIRTUAL_TERMINAL_INPUT
      changed = true
    }
    if (changed) k32!.symbols.SetConsoleMode(handle, mode)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ((mode: boolean) => unknown) | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
