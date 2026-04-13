/*
 * opencode_compat.dll — Windows Server 2016 compatibility shim.
 *
 * Provides GetThreadDescription and SetThreadDescription exports.
 * On Server 2016 these exist in KernelBase.dll but may be missing
 * from kernel32.dll on unpatched systems. This DLL dynamically
 * resolves them from KernelBase.dll, falling back to safe stubs.
 *
 * Cross-compile on Linux:
 *   x86_64-w64-mingw32-gcc -shared -o opencode_compat.dll \
 *       winserver2016_compat.c -lkernel32 -Wl,--kill-at
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

typedef HRESULT (WINAPI *PFN_GetThreadDescription)(HANDLE, PWSTR*);
typedef HRESULT (WINAPI *PFN_SetThreadDescription)(HANDLE, PCWSTR);

static PFN_GetThreadDescription pfnGet = NULL;
static PFN_SetThreadDescription pfnSet = NULL;
static int resolved = 0;

static void resolve_functions(void) {
    HMODULE hKB;
    if (resolved) return;
    resolved = 1;

    /* Try KernelBase.dll first (always loaded, has these on Server 2016) */
    hKB = GetModuleHandleA("KernelBase.dll");
    if (hKB) {
        pfnGet = (PFN_GetThreadDescription)GetProcAddress(hKB, "GetThreadDescription");
        pfnSet = (PFN_SetThreadDescription)GetProcAddress(hKB, "SetThreadDescription");
    }

    /* Fallback: try kernel32 in case of newer Windows */
    if (!pfnGet || !pfnSet) {
        HMODULE hK32 = GetModuleHandleA("kernel32.dll");
        if (hK32) {
            if (!pfnGet)
                pfnGet = (PFN_GetThreadDescription)GetProcAddress(hK32, "GetThreadDescription");
            if (!pfnSet)
                pfnSet = (PFN_SetThreadDescription)GetProcAddress(hK32, "SetThreadDescription");
        }
    }
}

__declspec(dllexport) HRESULT WINAPI GetThreadDescription(HANDLE hThread, PWSTR *ppszDesc) {
    resolve_functions();
    if (pfnGet)
        return pfnGet(hThread, ppszDesc);
    /* Stub: return empty string */
    *ppszDesc = (PWSTR)LocalAlloc(LMEM_ZEROINIT, sizeof(WCHAR) * 2);
    if (!*ppszDesc) return E_OUTOFMEMORY;
    return S_OK;
}

__declspec(dllexport) HRESULT WINAPI SetThreadDescription(HANDLE hThread, PCWSTR lpDesc) {
    resolve_functions();
    if (pfnSet)
        return pfnSet(hThread, lpDesc);
    /* Stub: silently succeed */
    return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpReserved) {
    (void)hinstDLL; (void)lpReserved;
    (void)fdwReason;
    return TRUE;
}
