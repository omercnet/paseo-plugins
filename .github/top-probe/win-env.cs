using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PasoEnv {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process(IntPtr handle, out bool wow64);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int cls, ref Pbi info, int length, out int returned);

  [StructLayout(LayoutKind.Sequential)]
  struct Pbi { public IntPtr Exit; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr ParentPid; }

  static byte[] Read(IntPtr handle, long address, int size) {
    var buffer = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(handle, new IntPtr(address), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
    return buffer;
  }

  /// "error:<what>" or "none" or the agent id. Only the id is ever returned.
  public static string AgentId(int pid) {
    var handle = OpenProcess(0x1000 | 0x0010, false, pid); // QUERY_LIMITED_INFORMATION | VM_READ
    if (handle == IntPtr.Zero) return "error:open" + Marshal.GetLastWin32Error();
    try {
      bool wow64;
      if (IsWow64Process(handle, out wow64) && wow64) return "error:wow64";
      var pbi = new Pbi(); int returned;
      if (NtQueryInformationProcess(handle, 0, ref pbi, Marshal.SizeOf(pbi), out returned) != 0) return "error:ntquery";
      var peb = Read(handle, pbi.Peb.ToInt64() + 0x20, 8);
      if (peb == null) return "error:peb";
      var parameters = BitConverter.ToInt64(peb, 0);
      var env = Read(handle, parameters + 0x80, 8);
      var size = Read(handle, parameters + 0x3F0, 8);
      if (env == null || size == null) return "error:params";
      var length = (int)Math.Min(BitConverter.ToInt64(size, 0), 1 << 20);
      if (length <= 0) return "error:size";
      var block = Read(handle, BitConverter.ToInt64(env, 0), length);
      if (block == null) return "error:env";
      foreach (var entry in Encoding.Unicode.GetString(block).Split('\0')) {
        if (entry.StartsWith("PASEO_AGENT_ID=", StringComparison.Ordinal)) return entry.Substring(15);
      }
      return "none";
    } finally { CloseHandle(handle); }
  }
}
