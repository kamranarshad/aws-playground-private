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

    public static void main(String[] argv) throws Exception {
        long harnessStart = System.nanoTime();
        Map<String, String> args = parseArgs(argv);
        String resultFile = args.get("--result-file");
        String handlerSpec = args.getOrDefault("--handler", "");
        long timeoutMs = Long.parseLong(args.getOrDefault("--timeout-ms", "30000"));
        int memoryMb = Integer.parseInt(args.getOrDefault("--memory-mb", "128"));
        String requestId = args.getOrDefault("--request-id", UUID.randomUUID().toString());

        String eventJson = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);

        String className = handlerSpec;
        String methodName = "handleRequest";
        int sep = handlerSpec.indexOf("::");
        if (sep != -1) {
            className = handlerSpec.substring(0, sep);
            methodName = handlerSpec.substring(sep + 2);
        }

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
            writeResult(resultFile, envelope(false, "init", null, error(t), 0, null));
            return;
        }

        long deadline = System.currentTimeMillis() + timeoutMs;
        Class<?>[] pts = method.getParameterTypes();
        long start = System.nanoTime();
        double initMs = (start - harnessStart) / 1e6;
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

    static Map<String, String> parseArgs(String[] argv) {
        Map<String, String> out = new HashMap<>();
        for (int i = 0; i + 1 < argv.length; i += 2) out.put(argv[i], argv[i + 1]);
        return out;
    }

    static String env(String key, String fallback) {
        String v = System.getenv(key);
        return v == null ? fallback : v;
    }
}
