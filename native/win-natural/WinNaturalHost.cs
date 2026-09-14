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
    private sealed record RawRegistryOpen(
        [property: JsonPropertyName("status")] int Status,
        [property: JsonPropertyName("statusName")] string StatusName);

    private const int MaxMessageBytes = 16 * 1024 * 1024;
    private const int MaxSynthesisTextCharacters = 100_000;
    private const int SynthesisChunkBytes = 48 * 1024;
    private const int MaxSynthesisBytes = 8 * 1024 * 1024;
    private static readonly object OutputGate = new();
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static SpeechSynthesizer? Synthesizer;

    private sealed record TimingBoundary(
        [property: JsonPropertyName("charIndex")] int CharIndex,
        [property: JsonPropertyName("charLength")] int CharLength,
        [property: JsonPropertyName("audioMs")] double AudioMs);

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
                token = TokenDiagnostics(),
                parentProcess = ParentProcessDiagnostics(),
                is64BitProcess = Environment.Is64BitProcess,
                osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
                installedVoiceCount = installed.Count,
                installedVoices = voiceDiagnostics,
                environment = RelevantEnvironment(),
                registry = RegistryDiagnostics()
            }
        };
    }

    private static void Synthesize(string requestId, string voiceId, string text)
    {
        if (string.IsNullOrWhiteSpace(requestId)) throw new InvalidOperationException("Missing synthesis request ID.");
        if (!voiceId.StartsWith("Local-", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Windows Natural synthesis requires a Local-* voice ID.");
        if (string.IsNullOrWhiteSpace(text) || text.Length > MaxSynthesisTextCharacters)
            throw new InvalidOperationException("Windows Natural synthesis text is empty or too large.");

        var synthesizer = GetSynthesizer();
        var matches = synthesizer.GetInstalledVoices()
            .Where(voice => string.Equals(voice.VoiceInfo.Id, voiceId, StringComparison.Ordinal))
            .ToArray();
        if (matches.Length != 1 || !matches[0].Enabled)
            throw new InvalidOperationException($"Enabled SAPI voice token was not found: {voiceId}");

        var selectedName = matches[0].VoiceInfo.Name;
        synthesizer.SelectVoice(selectedName);
        if (!string.Equals(synthesizer.Voice?.Id, voiceId, StringComparison.Ordinal))
            throw new InvalidOperationException("SAPI selected a different voice token than requested.");

        using var audio = new MemoryStream();
        synthesizer.SetOutputToWaveStream(audio);
        var timing = new List<TimingBoundary>();
        EventHandler<SpeakProgressEventArgs> progressHandler = (_, progress) =>
        {
            var charIndex = progress.CharacterPosition;
            var charLength = progress.CharacterCount;
            var audioMs = progress.AudioPosition.TotalMilliseconds;
            var previousAudioMs = timing.Count == 0 ? 0 : timing[^1].AudioMs;
            if (charIndex < 0 || charLength <= 0 || charIndex > text.Length - charLength ||
                !double.IsFinite(audioMs) || audioMs < 0 || audioMs < previousAudioMs) return;
            timing.Add(new TimingBoundary(charIndex, charLength, Math.Round(audioMs, 3, MidpointRounding.AwayFromZero)));
        };
        synthesizer.SpeakProgress += progressHandler;
        try
        {
            synthesizer.Speak(text);
        }
        finally
        {
            synthesizer.SpeakProgress -= progressHandler;
            synthesizer.SetOutputToNull();
        }
        var wav = audio.ToArray();
        if (wav.Length == 0 || wav.Length > MaxSynthesisBytes)
            throw new InvalidOperationException("Native synthesis returned an invalid WAV size.");

        var chunkCount = (wav.Length + SynthesisChunkBytes - 1) / SynthesisChunkBytes;
        Send(new { type = "synth-start", requestId, voiceId, totalBytes = wav.Length, chunkBytes = SynthesisChunkBytes, chunkCount });
        for (var index = 0; index < chunkCount; index++)
        {
            var offset = index * SynthesisChunkBytes;
            var count = Math.Min(SynthesisChunkBytes, wav.Length - offset);
            Send(new { type = "synth-chunk", requestId, index, data = Convert.ToBase64String(wav, offset, count) });
        }
        Send(new { type = "synth-end", requestId, totalBytes = wav.Length, chunkCount, timing });
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
                .ToArray(),
            raw = RawRegistryDiagnostics(sid),
            summary = RawRegistrySummary(sid)
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

    private static object RawRegistryDiagnostics(string? sid)
    {
        var views = new[] { ("Registry64", 0x0100u), ("Registry32", 0x0200u) }
            .Select(item => new
            {
                view = item.Item1,
                currentUser = RawOpen(HkeyCurrentUser, AdapterEnumeratorPath, KeyRead | item.Item2),
                usersSid = sid == null
                    ? new RawRegistryOpen(-1, "no SID")
                    : RawOpen(HkeyUsers, $@"{sid}\{AdapterEnumeratorPath}", KeyRead | item.Item2),
                regOpenCurrentUser = RawOpenCurrentUser(KeyRead | item.Item2)
            })
            .ToArray();
        return new { views };
    }

    private static string RawRegistrySummary(string? sid)
    {
        var parts = new List<string>();
        foreach (var (label, view) in new[] { ("64", 0x0100u), ("32", 0x0200u) })
        {
            var hkcu = RawOpen(HkeyCurrentUser, AdapterEnumeratorPath, KeyRead | view);
            var users = sid == null
                ? new RawRegistryOpen(-1, "no SID")
                : RawOpen(HkeyUsers, $@"{sid}\{AdapterEnumeratorPath}", KeyRead | view);
            var current = RawOpenCurrentUser(KeyRead | view);
            parts.Add($"{label}:HKCU={hkcu.StatusName};HKEY_USERS={users.StatusName};RegOpenCurrentUser={current.StatusName}");
        }
        return string.Join(" | ", parts);
    }

    private static RawRegistryOpen RawOpen(IntPtr root, string path, uint access)
    {
        var status = RegOpenKeyEx(root, path, 0, access, out var handle);
        if (status == 0) RegCloseKey(handle);
        return new RawRegistryOpen(status, Win32Status(status));
    }

    private static RawRegistryOpen RawOpenCurrentUser(uint access)
    {
        var status = RegOpenCurrentUser(access, out var handle);
        if (status == 0) RegCloseKey(handle);
        return new RawRegistryOpen(status, Win32Status(status));
    }

    private static string Win32Status(int status) => status switch
    {
        0 => "ERROR_SUCCESS",
        2 => "ERROR_FILE_NOT_FOUND",
        3 => "ERROR_PATH_NOT_FOUND",
        5 => "ERROR_ACCESS_DENIED",
        6 => "ERROR_INVALID_HANDLE",
        _ => $"WIN32_{status}"
    };

    private static object TokenDiagnostics()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var token = identity.Token;
        var elevationType = TokenUInt32(token, 18);
        return new
        {
            isAppContainer = TokenBool(token, 29),
            isRestricted = TokenBool(token, 40),
            elevationType = elevationType switch
            {
                1 => "Default",
                2 => "Full",
                3 => "Limited",
                _ => $"Unknown({elevationType})"
            },
            virtualizationAllowed = TokenBool(token, 23),
            virtualizationEnabled = TokenBool(token, 24),
            packageSid = TokenSid(token, 41),
            restrictedSids = TokenSidCount(token, 11)
        };
    }

    private static bool TokenBool(IntPtr token, int informationClass) => TokenUInt32(token, informationClass) != 0;

    private static uint TokenUInt32(IntPtr token, int informationClass)
    {
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out var length);
        if (length < 4) return 0;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            return GetTokenInformation(token, informationClass, buffer, length, out _)
                ? (uint)Marshal.ReadInt32(buffer)
                : 0;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string? TokenSid(IntPtr token, int informationClass)
    {
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out var length);
        if (length <= 0) return null;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, length, out _)) return null;
            var sid = Marshal.ReadIntPtr(buffer);
            return sid == IntPtr.Zero ? null : new SecurityIdentifier(sid).Value;
        }
        catch { return null; }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int TokenSidCount(IntPtr token, int informationClass)
    {
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out var length);
        if (length <= 0) return 0;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, length, out _)) return 0;
            return Marshal.ReadInt32(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static object ParentProcessDiagnostics()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            var basic = new ProcessBasicInformation();
            var status = NtQueryInformationProcess(process.Handle, 0, ref basic, Marshal.SizeOf<ProcessBasicInformation>(), out _);
            if (status != 0) return new { pid = (int?)null, name = (string?)null, status };
            var parentPid = basic.InheritedFromUniqueProcessId.ToInt32();
            using var parent = Process.GetProcessById(parentPid);
            return new { pid = (int?)parentPid, name = parent.ProcessName, status = 0 };
        }
        catch (Exception error) { return new { pid = (int?)null, name = (string?)null, status = error.Message }; }
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

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegOpenKeyEx(IntPtr hKey, string subKey, uint options, uint samDesired, out IntPtr result);

    [DllImport("advapi32.dll")]
    private static extern int RegOpenCurrentUser(uint samDesired, out IntPtr result);

    [DllImport("advapi32.dll")]
    private static extern int RegCloseKey(IntPtr hKey);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass,
        ref ProcessBasicInformation processInformation, int processInformationLength, out int returnLength);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthorityIndex);

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private static readonly IntPtr HkeyCurrentUser = new(unchecked((long)0x80000001));
    private static readonly IntPtr HkeyUsers = new(unchecked((long)0x80000003));
    private const uint KeyRead = 0x20019;
    private const string AdapterEnumeratorPath = @"Software\NaturalVoiceSAPIAdapter\Enumerator";

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
            case "synthesize":
                var voiceId = message.TryGetProperty("voiceId", out var voiceValue) ? voiceValue.GetString() ?? "" : "";
                var text = message.TryGetProperty("text", out var textValue) ? textValue.GetString() ?? "" : "";
                Synthesize(requestId, voiceId, text);
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
