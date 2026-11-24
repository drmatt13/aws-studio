#Requires -Version 7.0
# CI only: normalize this short-lived shell's default object owner. Descendant
# verification processes retain the same user, groups and privileges.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The Windows CI token owner helper requires Windows.' }

if (-not ('StudioCiTokenOwner' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class StudioCiTokenOwner
{
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustDefault = 0x0080;
    private const int TokenUser = 1;
    private const int TokenOwner = 4;
    private const int InsufficientBuffer = 122;

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, IntPtr information, int length, out int required);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetTokenInformation(SafeAccessTokenHandle token, int informationClass, IntPtr information, int length);

    private static IntPtr ReadInformation(SafeAccessTokenHandle token, int informationClass)
    {
        int required;
        bool result = GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out required);
        int error = Marshal.GetLastWin32Error();
        if (result || error != InsufficientBuffer || required <= 0 || required > 65536)
            throw new Win32Exception(error, "Windows could not size the CI process token information.");
        IntPtr information = Marshal.AllocHGlobal(required);
        try
        {
            if (!GetTokenInformation(token, informationClass, information, required, out required))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not read the CI process token information.");
            return information;
        }
        catch { Marshal.FreeHGlobal(information); throw; }
    }

    public static void UseCurrentUserOwner()
    {
        SafeAccessTokenHandle token;
        // GetCurrentProcess is a pseudo-handle to this PowerShell process only.
        // Never open a parent process or enable any privilege.
        if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenAdjustDefault, out token))
        {
            int error = Marshal.GetLastWin32Error();
            if (token != null) token.Dispose();
            throw new Win32Exception(error, "Windows could not open the CI shell's own process token.");
        }
        using (token)
        {
            IntPtr user = IntPtr.Zero, owner = IntPtr.Zero, confirmed = IntPtr.Zero;
            try
            {
                user = ReadInformation(token, TokenUser);
                IntPtr userSid = Marshal.ReadIntPtr(user);
                SecurityIdentifier expected = new SecurityIdentifier(userSid);
                owner = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(owner, userSid);
                if (!SetTokenInformation(token, TokenOwner, owner, IntPtr.Size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not set the CI shell's default owner to its user SID.");
                confirmed = ReadInformation(token, TokenOwner);
                if (!expected.Equals(new SecurityIdentifier(Marshal.ReadIntPtr(confirmed))))
                    throw new InvalidOperationException("The CI shell's default owner did not match its user SID.");
            }
            finally
            {
                if (confirmed != IntPtr.Zero) Marshal.FreeHGlobal(confirmed);
                if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner);
                if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
            }
        }
    }
}
'@
}

[StudioCiTokenOwner]::UseCurrentUserOwner()
