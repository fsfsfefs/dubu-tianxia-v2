# Read only the target process working-directory string; fail closed on denied access.
if (-not ('ReaderProcessDirectory' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ReaderProcessDirectory {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInfo {
        public IntPtr Reserved1, Peb, Reserved2, Reserved3, ProcessId, ParentId;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool IsWow64Process(IntPtr handle, out bool wow64);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int kind, out BasicInfo info, int length, out int needed);
    [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")]
    private static extern int QueryWow64(IntPtr handle, int kind, out IntPtr info, int length, out int needed);
    private static byte[] Read(IntPtr handle, IntPtr address, int count) {
        byte[] bytes = new byte[count]; IntPtr read;
        if (address == IntPtr.Zero || !ReadProcessMemory(handle,address,bytes,new IntPtr(count),out read) || read.ToInt64()!=count) return null;
        return bytes;
    }
    private static IntPtr Pointer(byte[] bytes, int offset, int width) {
        return width==8 ? new IntPtr(BitConverter.ToInt64(bytes,offset)) : new IntPtr((long)BitConverter.ToUInt32(bytes,offset));
    }
    public static string GetWorkingDirectory(int id) {
        IntPtr handle=OpenProcess(0x410,false,id); // QUERY_INFORMATION | VM_READ; never write or terminate.
        if(handle==IntPtr.Zero)return null;
        try {
            bool wow64;
            if(!IsWow64Process(handle,out wow64))return null;
            int width=Environment.Is64BitOperatingSystem && !wow64 ? 8 : 4;
            if(IntPtr.Size<width)return null;
            int needed; IntPtr peb;
            if(wow64 && IntPtr.Size==8) {
                if(QueryWow64(handle,26,out peb,IntPtr.Size,out needed)!=0)return null;
            } else {
                BasicInfo info;
                if(NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(BasicInfo)),out needed)!=0)return null;
                peb=info.Peb;
            }
            byte[] parameterPointer=Read(handle,IntPtr.Add(peb,width==8?0x20:0x10),width);
            if(parameterPointer==null)return null;
            IntPtr parameters=Pointer(parameterPointer,0,width);
            byte[] directory=Read(handle,IntPtr.Add(parameters,width==8?0x38:0x24),width==8?16:8);
            if(directory==null)return null;
            int length=BitConverter.ToUInt16(directory,0);
            if(length==0 || length>32766 || length%2!=0)return null;
            byte[] text=Read(handle,Pointer(directory,width==8?8:4,width),length);
            return text==null?null:Encoding.Unicode.GetString(text);
        } catch { return null; }
        finally { CloseHandle(handle); }
    }
}
"@
}
