import unittest

from bodyos_mac.api import create_app


class InputLimitTests(unittest.IsolatedAsyncioTestCase):
    async def send_chunks(self, *, token="", headers=None, chunks=None):
        app = create_app(session_token=token, max_upload_bytes=64)
        pending = list(chunks or [b"not valid multipart"])
        consumed = 0
        messages = []

        async def receive():
            nonlocal consumed
            if not pending:
                return {"type": "http.disconnect"}
            consumed += 1
            return {"type": "http.request", "body": pending.pop(0), "more_body": bool(pending)}

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http", "http_version": "1.1", "scheme": "http",
            "method": "POST", "path": "/v1/glasses/photos",
            "raw_path": b"/v1/glasses/photos", "query_string": b"device_id=glasses-test",
            "headers": [(b"content-type", b"multipart/form-data; boundary=fixture"), *(headers or [])],
            "server": ("testserver", 80), "client": ("127.0.0.1", 1234),
        }
        await app(scope, receive, send)
        statuses = [message["status"] for message in messages if message["type"] == "http.response.start"]
        self.assertEqual(len(statuses), 1)
        return statuses[0], consumed

    async def test_unauthorized_upload_is_rejected_before_reading_or_parsing_its_body(self):
        status, consumed = await self.send_chunks(token="test-token")
        self.assertEqual(status, 401)
        self.assertEqual(consumed, 0)

    async def test_oversized_chunked_body_stops_before_all_chunks_are_consumed(self):
        body = (
            b'--fixture\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\n'
            b"Content-Type: image/jpeg\r\n\r\n" + b"x" * (2 * 1024 * 1024)
            + b'\r\n--fixture\r\nContent-Disposition: form-data; name="requestId"\r\n\r\ncapture-test'
            b"\r\n--fixture--\r\n"
        )
        chunks = [body[offset:offset + 16_384] for offset in range(0, len(body), 16_384)]
        status, consumed = await self.send_chunks(chunks=chunks)
        self.assertEqual(status, 413)
        self.assertLess(consumed, len(chunks))

    async def test_oversized_content_length_is_rejected_without_reading_body(self):
        status, consumed = await self.send_chunks(headers=[(b"content-length", b"2097152")])
        self.assertEqual(status, 413)
        self.assertEqual(consumed, 0)
