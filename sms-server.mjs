const SMS_SERVER = "http://localhost:3939";

export function waitForOtp() {
  return new Promise((resolve, reject) => {
    console.log("Connecting to SMS server SSE stream...");

    const url = `${SMS_SERVER}/stream?sender_pattern=Sheba|SHEBA`;
    let controller = new AbortController();

    fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);
        console.log("Waiting for OTP from SMS Forwarder...");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        function read() {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                reject(new Error("SSE stream closed"));
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop(); // keep incomplete line in buffer

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const msg = JSON.parse(line.slice(6));
                  if (msg.otp) {
                    console.log(`\nSMS received from ${msg.sender}`);
                    console.log(`Body: ${msg.body}`);
                    console.log(`OTP: ${msg.otp}`);
                    controller.abort();
                    resolve(msg.otp);
                    return;
                  }
                } catch {
                  // ignore parse errors on keepalive comments
                }
              }

              read();
            })
            .catch((err) => {
              if (err.name !== "AbortError") reject(err);
            });
        }

        read();
      })
      .catch((err) => {
        if (err.name !== "AbortError") reject(err);
      });
  });
}

export function startServer() {
  // No longer needed — the central SMS server handles this
  return Promise.resolve();
}

export function stopServer() {
  // No longer needed
}
