// Sample compiled OS-only lambda: a Go bootstrap speaking the Lambda
// Runtime API with the stdlib only. In the playground, register this
// folder with runtime "provided", handler "bootstrap", and build command
// "go build -o bootstrap ." — the same binary works on provided.al2023.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

func main() {
	api := fmt.Sprintf("http://%s/2018-06-01/runtime", os.Getenv("AWS_LAMBDA_RUNTIME_API"))

	for {
		resp, err := http.Get(api + "/invocation/next")
		if err != nil {
			fmt.Fprintln(os.Stderr, "runtime API unreachable:", err)
			os.Exit(1)
		}
		requestID := resp.Header.Get("Lambda-Runtime-Aws-Request-Id")

		var event map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&event); err != nil {
			event = map[string]any{}
		}
		resp.Body.Close()

		result := map[string]any{"runtime": "go", "eventKeys": len(event)}
		if name, ok := event["name"].(string); ok {
			result["greeting"] = "hello, " + name
		}
		body, _ := json.Marshal(result)

		post, _ := http.Post(
			fmt.Sprintf("%s/invocation/%s/response", api, requestID),
			"application/json", bytes.NewReader(body))
		post.Body.Close()
	}
}
