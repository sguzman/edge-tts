using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Speech.Synthesis;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;
using System.Security.Principal;

// Gate 1 transport-only host. The existing adapter exposes the extracted
// Natural voice as a Local-* SAPI voice; this host only handshakes/enumerates.
internal static class WinNaturalHost
{
    private sealed record EnumeratorSnapshot(
        [property: JsonPropertyName("exists")] bool Exists,
        [property: JsonPropertyName("values")] Dictionary<string, string?> Values);

    private const int MaxMessageBytes = 16 * 1024 * 1024;
    private static readonly object OutputGate = new();
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static SpeechSynthesizer? Synthesizer;

    private static SpeechSynthesizer GetSynthesizer() => Synthesizer ??= new SpeechSynthesizer();

    private static void Send(object message)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message);
        if (payload.Length > MaxMessageBytes) throw new InvalidOperationException("Native response is too large.");
        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        lock (OutputGate)
        {
            Output.Write(header);
            Output.Write(payload);
            Output.Flush();
        }
    }

    private static bool TryReadExactly(Stream input, Span<byte> buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = input.Read(buffer[offset..]);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    private static object EnumerateVoices(string requestId)
    {
        var installed = GetSynthesizer().GetInstalledVoices();
        var voiceDiagnostics = installed.Select(voice =>
        {
            try
            {
                return new
                {
                    id = voice.VoiceInfo.Id,
                    name = voice.VoiceInfo.Name,
                    enabled = voice.Enabled,
                    error = (string?)null
                };
            }
            catch (Exception error)
            {
                return new
                {
                    id = "",
                    name = "",
                    enabled = false,
                    error = (string?)error.Message
                };
            }
        }).ToArray();
        var voices = installed
            .Where(voice => voice.VoiceInfo.Id.StartsWith("Local-", StringComparison.OrdinalIgnoreCase))
            .Select(voice => new
            {
                id = voice.VoiceInfo.Id,
                name = voice.VoiceInfo.Name,
                lang = voice.VoiceInfo.Culture.Name
            })
            .ToArray();
        return new
        {
            type = "voices",
            requestId,
            architecture = "x64",
            voices,
            diagnostics = new
            {
                executablePath = Process.GetCurrentProcess().MainModule?.FileName,
                currentDirectory = Directory.GetCurrentDirectory(),
                user = WindowsIdentity.GetCurrent().Name,
                userSid = WindowsIdentity.GetCurrent().User?.Value,
                integrityLevel = IntegrityLevel(),
                is64BitProcess = Environment.Is64BitProcess,
                osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
                installedVoiceCount = installed.Count,
                installedVoices = voiceDiagnostics,
                environment = RelevantEnvironment(),
                registry = RegistryDiagnostics()
            }
        };
    }

    private static Dictionary<string, string?> RelevantEnvironment() => new()
    {
        ["LOCALAPPDATA"] = Environment.GetEnvironmentVariable("LOCALAPPDATA"),
        ["USERPROFILE"] = Environment.GetEnvironmentVariable("USERPROFILE"),
        ["PROGRAMFILES"] = Environment.GetEnvironmentVariable("ProgramFiles"),
        ["PROGRAMFILES_X86"] = Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
        ["PATH_RELEVANT"] = string.Join(";", (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Where(value => value.Contains("Natural", StringComparison.OrdinalIgnoreCase)
                || value.Contains("Speech", StringComparison.OrdinalIgnoreCase)
                || value.Contains("System32", StringComparison.OrdinalIgnoreCase)
                || value.Contains("dotnet", StringComparison.OrdinalIgnoreCase)))
    };

    private static object RegistryDiagnostics()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value;
        var currentUser = ReadEnumerator(Registry.CurrentUser.OpenSubKey(@"Software\NaturalVoiceSAPIAdapter\Enumerator"));
        var usersSid = sid == null
            ? null
            : ReadEnumerator(Registry.Users.OpenSubKey($@"{sid}\Software\NaturalVoiceSAPIAdapter\Enumerator"));
        var narratorPath = currentUser.Values.TryGetValue("NarratorVoicePath", out var configuredPath)
            ? configuredPath
            : null;
        return new
        {
            currentUserSid = sid,
            currentUser,
            hkeyUsersCurrentSid = usersSid,
            narratorVoicePath = narratorPath,
            narratorVoicePathIsRooted = narratorPath != null && Path.IsPathRooted(narratorPath),
            narratorVoicePathExists = narratorPath != null && Directory.Exists(narratorPath),
            views = new[] { RegistryView.Registry64, RegistryView.Registry32 }
                .Select(view => RegistryViewDiagnostics(view))
                .ToArray()
        };
    }

    private static object RegistryViewDiagnostics(RegistryView view)
    {
        using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
        using var currentUser = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view);
        using var users = RegistryKey.OpenBaseKey(RegistryHive.Users, view);
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        var userEnumerator = sid == null
            ? null
            : users.OpenSubKey($@"{sid}\Software\NaturalVoiceSAPIAdapter\Enumerator");
        var adapterPaths = FindAdapterPaths(localMachine.OpenSubKey(@"SOFTWARE\Classes\CLSID"));
        var machineTokens = CountLocalTokens(localMachine.OpenSubKey(@"SOFTWARE\Microsoft\Speech\Voices\Tokens"));
        var userTokens = CountLocalTokens(currentUser.OpenSubKey(@"Software\Microsoft\Speech\Voices\Tokens"));
        return new
        {
            view = view.ToString(),
            adapterEnumerator = ReadEnumerator(userEnumerator),
            adapterPaths,
            adapterFilesExist = adapterPaths.All(File.Exists),
            machineSapiTokenCount = machineTokens.total,
            machineLocalTokenCount = machineTokens.local,
            userSapiTokenCount = userTokens.total,
            userLocalTokenCount = userTokens.local
        };
    }

    private static EnumeratorSnapshot ReadEnumerator(RegistryKey? key)
    {
        if (key == null) return new EnumeratorSnapshot(false, new Dictionary<string, string?>());
        using (key)
        {
            return new EnumeratorSnapshot(true,
                key.GetValueNames().ToDictionary(name => name, name => key.GetValue(name)?.ToString()));
        }
    }

    private static string IntegrityLevel()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value;
        var token = identity.Token;
        if (token == IntPtr.Zero) return "unknown";
        GetTokenInformation(token, 25, IntPtr.Zero, 0, out var length);
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, 25, buffer, length, out _)) return "unknown";
            var integritySid = Marshal.ReadIntPtr(buffer);
            var subAuthorityCount = Marshal.ReadByte(GetSidSubAuthorityCount(integritySid));
            if (subAuthorityCount == 0) return "unknown";
            var rid = Marshal.ReadInt32(GetSidSubAuthority(integritySid, (uint)(subAuthorityCount - 1)));
            return rid switch
            {
                >= 0x5000 => "protected",
                >= 0x4000 => "system",
                >= 0x3000 => "high",
                >= 0x2000 => "medium",
                _ => "low"
            };
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass,
        IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthorityIndex);

    private static string[] FindAdapterPaths(RegistryKey? clsids)
    {
        if (clsids == null) return Array.Empty<string>();
        using (clsids)
        {
            return clsids.GetSubKeyNames()
                .Select(name => clsids.OpenSubKey(name)?.OpenSubKey("InprocServer32")?.GetValue(null) as string)
                .Where(path => path?.Contains("NaturalVoiceSAPIAdapter", StringComparison.OrdinalIgnoreCase) == true)
                .Cast<string>()
                .ToArray();
        }
    }

    private static (int total, int local) CountLocalTokens(RegistryKey? tokens)
    {
        if (tokens == null) return (0, 0);
        using (tokens)
        {
            var names = tokens.GetSubKeyNames();
            return (names.Length, names.Count(name => name.StartsWith("Local-", StringComparison.OrdinalIgnoreCase)));
        }
    }

    private static void Handle(JsonElement message)
    {
        var type = message.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : "";
        var requestId = message.TryGetProperty("requestId", out var idValue) ? idValue.GetString() ?? "" : "";
        switch (type)
        {
            case "hello":
                Send(new { type = "hello", requestId, protocol = 1, architecture = "x64" });
                break;
            case "voices":
                Send(EnumerateVoices(requestId));
                break;
            default:
                Send(new { type = "error", requestId, message = $"Unsupported request type: {type}" });
                break;
        }
    }

    public static void Main()
    {
        using var input = Console.OpenStandardInput();
        Span<byte> header = stackalloc byte[4];
        while (TryReadExactly(input, header))
        {
            var length = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (length <= 0 || length > MaxMessageBytes)
            {
                Send(new { type = "error", requestId = "", message = "Invalid Native Messaging frame length." });
                break;
            }

            var payload = new byte[length];
            if (!TryReadExactly(input, payload)) break;
            try
            {
                using var document = JsonDocument.Parse(payload);
                Handle(document.RootElement);
            }
            catch (Exception error)
            {
                Send(new { type = "error", requestId = "", message = error.Message });
            }
        }
    }
}
