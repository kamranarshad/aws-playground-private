import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * AWS Lambda Playground java harness. Run with cwd = the user's project dir
 * and classpath = harness.jar + the user's built (fat) jar. Reads event JSON
 * from stdin, finds the handler via reflection, invokes it, and writes an
 * envelope to --result-file. Context/LambdaLogger are dynamic proxies over
 * the interfaces in the user's jar, so no AWS libraries are compiled in.
 */
public class Harness {
    static final Gson GSON = new GsonBuilder().serializeNulls().create();

    static final String SENTINEL_PREFIX = "\0AWSPLAY-END:";
    static final String SENTINEL_SUFFIX = "\0";

    // Reads one length-prefixed frame from stdin, or null at end of stream.
    // Length-prefixed rather than line-delimited: an event JSON may contain a
    // literal newline inside a string, which a line reader would split in half.
    static String readFrame(InputStream in) throws Exception {
        StringBuilder header = new StringBuilder();
        int c;
        while ((c = in.read()) != -1 && c != '\n') header.append((char) c);
        if (c == -1 && header.length() == 0) return null;
        int need = Integer.parseInt(header.toString().trim());
        byte[] body = new byte[need];
        int read = 0;
        while (read < need) {
            int n = in.read(body, read, need - read);
            if (n == -1) return null;
            read += n;
        }
        return new String(body, StandardCharsets.UTF_8);
    }

    public static void main(String[] argv) throws Exception {
        long harnessStart = System.nanoTime();
        Map<String, String> args = parseArgs(argv);
        String resultFile = args.get("--result-file");
        String handlerSpec = args.getOrDefault("--handler", "");
        long timeoutMs = Long.parseLong(args.getOrDefault("--timeout-ms", "30000"));
        int memoryMb = Integer.parseInt(args.getOrDefault("--memory-mb", "128"));
        String requestId = args.getOrDefault("--request-id", UUID.randomUUID().toString());
        boolean warm = args.containsKey("--warm");

        String className = handlerSpec;
        String methodName = "handleRequest";
        int sep = handlerSpec.indexOf("::");
        if (sep != -1) {
            className = handlerSpec.substring(0, sep);
            methodName = handlerSpec.substring(sep + 2);
        }

        // Resolved once. In warm mode the cost of loading the class and
        // constructing the handler is the initMs reported on the first
        // response only; later invokes reuse this exact instance, which is
        // what makes instance state persist the way it does on Lambda.
        Object target = null;
        Method method;
        try {
            if (className.isEmpty()) throw new IllegalArgumentException(
                "Bad handler '" + handlerSpec + "': expected 'pkg.Class::method'");
            Class<?> cls = Class.forName(className);
            method = findMethod(cls, methodName);
            if (!Modifier.isStatic(method.getModifiers())) {
                target = cls.getDeclaredConstructor().newInstance();
            }
        } catch (Throwable t) {
            Map<String, Object> initError = envelope(false, "init", null, error(t), 0, null);
            if (!warm) {
                writeResult(resultFile, initError);
                return;
            }
            // The parent waits on a sentinel for the request *it* sent, not for
            // the one named on the command line, so report the init failure as
            // the answer to a real request. There is no handler to serve a
            // second one with.
            String initFrame = readFrame(System.in);
            if (initFrame != null) {
                Map<?, ?> req = GSON.fromJson(initFrame, Map.class);
                writeResult(String.valueOf(req.get("resultFile")), initError);
                System.out.flush();
                System.err.flush();
                System.out.print(SENTINEL_PREFIX + req.get("requestId") + SENTINEL_SUFFIX);
                System.out.flush();
            }
            return;
        }

        double initMs = (System.nanoTime() - harnessStart) / 1e6;

        if (!warm) {
            String eventJson = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
            runOne(method, target, eventJson, resultFile, requestId, timeoutMs, memoryMb, initMs);
            return;
        }

        boolean first = true;
        String frame;
        while ((frame = readFrame(System.in)) != null) {
            Map<?, ?> req = GSON.fromJson(frame, Map.class);
            String rid = String.valueOf(req.get("requestId"));
            String rfile = String.valueOf(req.get("resultFile"));
            long rtimeout = (long) Double.parseDouble(String.valueOf(req.get("timeoutMs")));
            int rmemory = (int) Double.parseDouble(String.valueOf(req.get("memoryMb")));
            String eventJson = GSON.toJson(req.get("event"));
            runOne(method, target, eventJson, rfile, rid, rtimeout, rmemory,
                first ? Double.valueOf(initMs) : null);
            first = false;
            // Flush before the sentinel: the parent cuts this invoke's logs at
            // the marker, so anything still buffered would land in the next.
            System.out.flush();
            System.err.flush();
            System.out.print(SENTINEL_PREFIX + rid + SENTINEL_SUFFIX);
            System.out.flush();
        }
    }

    static void runOne(Method method, Object target, String eventJson, String resultFile,
                       String requestId, long timeoutMs, int memoryMb, Double initMs)
            throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        Class<?>[] pts = method.getParameterTypes();
        long start = System.nanoTime();
        try {
            Object responseTree;
            if (pts.length == 3 && InputStream.class.isAssignableFrom(pts[0])) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                method.invoke(target,
                    new ByteArrayInputStream(eventJson.getBytes(StandardCharsets.UTF_8)),
                    out, makeContext(pts[2], requestId, deadline, memoryMb));
                String body = out.toString(StandardCharsets.UTF_8);
                responseTree = body.isEmpty() ? null : GSON.fromJson(body, Object.class);
            } else {
                Object eventObj = GSON.fromJson(eventJson, pts[0]);
                Object result;
                if (pts.length == 2) {
                    result = method.invoke(target, eventObj,
                        makeContext(pts[1], requestId, deadline, memoryMb));
                } else if (pts.length == 1) {
                    result = method.invoke(target, eventObj);
                } else {
                    throw new IllegalArgumentException("Unsupported handler signature: " + method);
                }
                responseTree = result == null ? null : GSON.toJsonTree(result);
            }
            double durationMs = (System.nanoTime() - start) / 1e6;
            writeResult(resultFile, envelope(true, "invoke", responseTree, null, durationMs, initMs));
        } catch (Throwable t) {
            double durationMs = (System.nanoTime() - start) / 1e6;
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException
                && t.getCause() != null ? t.getCause() : t;
            writeResult(resultFile, envelope(false, "invoke", null, error(cause), durationMs, null));
        }
    }

    static Method findMethod(Class<?> cls, String name) {
        List<Method> named = new ArrayList<>();
        for (Method m : cls.getMethods()) {
            if (m.getName().equals(name) && !m.isBridge() && !m.isSynthetic()
                && m.getParameterCount() >= 1 && m.getParameterCount() <= 3) {
                named.add(m);
            }
        }
        if (named.isEmpty()) throw new IllegalArgumentException(
            "No public method '" + name + "' with 1-3 parameters on " + cls.getName());
        // Prefer the most specific (non-Object first parameter).
        for (Method m : named) if (m.getParameterTypes()[0] != Object.class) return m;
        return named.get(0);
    }

    static Object makeContext(Class<?> ctxIface, String requestId, long deadline, int memoryMb) {
        if (!ctxIface.isInterface()) return null;
        String fnName = env("AWS_LAMBDA_FUNCTION_NAME", "playground");
        Map<String, Object> values = new HashMap<>();
        values.put("getAwsRequestId", requestId);
        values.put("getFunctionName", fnName);
        values.put("getFunctionVersion", env("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST"));
        values.put("getMemoryLimitInMB", memoryMb);
        values.put("getLogGroupName", "/aws/lambda/" + fnName);
        values.put("getLogStreamName", "playground");
        values.put("getInvokedFunctionArn", "arn:aws:lambda:" + env("AWS_REGION", "us-east-1")
            + ":000000000000:function:" + fnName);
        return Proxy.newProxyInstance(ctxIface.getClassLoader(), new Class<?>[]{ctxIface},
            (proxy, m, a) -> {
                if (m.getName().equals("getRemainingTimeInMillis")) {
                    return (int) Math.max(0, deadline - System.currentTimeMillis());
                }
                if (m.getName().equals("getLogger")) {
                    return makeLogger(m.getReturnType());
                }
                if (values.containsKey(m.getName())) return values.get(m.getName());
                if (m.getReturnType().isPrimitive()) return 0;
                return null;
            });
    }

    static Object makeLogger(Class<?> loggerIface) {
        if (!loggerIface.isInterface()) return null;
        return Proxy.newProxyInstance(loggerIface.getClassLoader(), new Class<?>[]{loggerIface},
            (proxy, m, a) -> {
                if (m.getName().equals("log") && a != null && a.length >= 1) {
                    if (a[0] instanceof byte[]) System.out.println(new String((byte[]) a[0], StandardCharsets.UTF_8));
                    else System.out.println(a[0]);
                }
                return null;
            });
    }

    static Map<String, Object> envelope(boolean ok, String phase, Object response,
                                        Map<String, Object> error, double durationMs, Double initMs) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("ok", ok);
        env.put("phase", phase);
        if (response != null) env.put("response", response);
        if (error != null) env.put("error", error);
        env.put("durationMs", durationMs);
        if (initMs != null) env.put("initMs", initMs);
        return env;
    }

    static Map<String, Object> error(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("type", t.getClass().getName());
        err.put("message", t.getMessage() == null ? t.toString() : t.getMessage());
        err.put("stackTrace", List.of(sw.toString().split("\n")));
        return err;
    }

    static void writeResult(String path, Map<String, Object> payload) throws Exception {
        Files.write(Paths.get(path), GSON.toJson(payload).getBytes(StandardCharsets.UTF_8));
    }

    // Handles valueless flags (--warm) as well as --key value pairs: pairing
    // strictly two-by-two would drop a trailing flag, or worse, swallow the
    // following argument as its value and desync everything after it.
    static Map<String, String> parseArgs(String[] argv) {
        Map<String, String> out = new HashMap<>();
        for (int i = 0; i < argv.length; i++) {
            if (!argv[i].startsWith("--")) continue;
            boolean hasValue = i + 1 < argv.length && !argv[i + 1].startsWith("--");
            out.put(argv[i], hasValue ? argv[i + 1] : "true");
            if (hasValue) i++;
        }
        return out;
    }

    static String env(String key, String fallback) {
        String v = System.getenv(key);
        return v == null ? fallback : v;
    }
}
