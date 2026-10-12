import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCaptureMode, captureMode, redact, redactString } from "../lib/redact.mjs";

test("redacts credentials with a recognisable shape or name", () => {
  const cases = {
    "access_token=supersecretvalue": "access_token=[REDACTED]",
    "OPENAI_API_KEY=abcd1234efgh5678": "OPENAI_API_KEY=[REDACTED]",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY": "AWS_SECRET_ACCESS_KEY=[REDACTED]",
    "SECRET_KEY=abc": "SECRET_KEY=[REDACTED]",
    "client_secret: 'supersecretvalue'": "client_secret: '[REDACTED]'",
    "password=hunter2": "password=[REDACTED]",
    "password=abc,defghijk": "password=[REDACTED]",
    "password=p@ss;word123": "password=[REDACTED]",
    "DB_PASSWORD=a<b>cdefgh": "DB_PASSWORD=[REDACTED]",
    'password="correct horse battery staple"': 'password="[REDACTED]"',
    "export API_KEY='abc def ghi'": "export API_KEY='[REDACTED]'",
    '{"password":"hunter2-horse","user":"me"}': '{"password":"[REDACTED]","user":"me"}',
    '{\\"password\\":\\"hunter2\\",\\"user\\":\\"me\\"}': '{\\"password\\":\\"[REDACTED]\\",\\"user\\":\\"me\\"}',
    "https://x.test/cb?token=abc123&state=ok": "https://x.test/cb?token=[REDACTED]&state=ok",
    "password is hunter22": "password is [REDACTED]",
    "authorization=Bearer supersecretvalue": "authorization=Bearer [REDACTED]",
    "curl -H 'Authorization: Bearer abc123def456ghi789'": "curl -H 'Authorization: Bearer [REDACTED]'",
    "authorization: bearer abc123def456ghi789": "authorization: bearer [REDACTED]",
    "curl -H 'authorization: basic dXNlcjpwYXNzd29yZA=='": "curl -H 'authorization: basic [REDACTED]'",
    "Authorization: Token 9944b09199c62bcf9418": "Authorization: Token [REDACTED]",
    "Authorization: abcdef0123456789": "Authorization: [REDACTED]",
    "sent Bearer abcdefghij0123456789xyz to the api": "sent Bearer [REDACTED] to the api",
    "AKIAIOSFODNN7EXAMPLE": "[REDACTED_AWS]",
    "github_pat_11AAAAAAA0abcdefghijklmnopqrstuv": "[REDACTED_GH]",
    "ghp_abcdefghijklmnopqrstuvwxyz": "[REDACTED_GH]",
    "AIzaSyA1234567890abcdefghij": "[REDACTED_GOOGLE]",
    "xoxc-1234567890-abcdef": "[REDACTED_SLACK]",
    "xapp-1-A0123456789-abcdef": "[REDACTED_SLACK]",
    "npm_1234567890abcdefghij": "[REDACTED_NPM]",
    "sk-ant-api03-abcdefghijklmnopqrst-AbC_dEf": "[REDACTED_KEY]",
    "sk_live_abcdefghijklmnop1234": "[REDACTED_KEY]",
    "postgres://admin:S3cretPassw0rd@db.internal:5432/prod": "postgres://[REDACTED]@db.internal:5432/prod",
    "postgres://u:p@ss@host/db": "postgres://[REDACTED]@host/db",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----": "[REDACTED_PEM]",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow": "[REDACTED_PEM]",
    "mysql --password hunter2 -h db": "mysql --password [REDACTED] -h db",
    "tool --api-key abc123 run": "tool --api-key [REDACTED] run",
    "curl -u admin:hunter2 https://x.test": "curl -u [REDACTED] https://x.test",
    "docker login -u me -p hunter2 registry.test": "docker login -u me -p [REDACTED] registry.test",
    "docker login -p one; docker ps": "docker login -p [REDACTED]; docker ps",
    [`AWS_${"X".repeat(100)}_PASSWORD=hunter2`]: `AWS_${"X".repeat(100)}_PASSWORD=[REDACTED]`,
    [`password="${"long secret ".repeat(1000)}"`]: 'password="[REDACTED]"',
    'password="never closed\nnext line': 'password="[REDACTED]\nnext line',
    'password=""': 'password="[REDACTED]"',
    [`Cookie: sid=${"a".repeat(9000)}`]: "Cookie: [REDACTED]",
    "{ cookie: 'sid=abc', user }": "{ cookie: '[REDACTED]', user }",
    '{"password": "ab\\"cdSECRET"}': '{"password": "[REDACTED]"}',
    '{\\"token\\": \\"ab\\\\\\"cd\\"}': '{\\"token\\": \\"[REDACTED]\\"}',
    "Cookie: a=1,2; session=SECRET": "Cookie: [REDACTED]",
    'Cookie: sid="s3cr3t"; other=SECRET2': "Cookie: [REDACTED]",
    'Cookie: prefs={"a":1}; session=SECRET': "Cookie: [REDACTED]",
    'docker login -p "my SECRET" registry.test': 'docker login -p "[REDACTED]" registry.test',
    'tool --password "two words" run': 'tool --password "[REDACTED]" run',
    'mysql --password \\"hunter2SECRET\\" db': 'mysql --password \\"[REDACTED]\\" db',
    'tool --password "ab\\"cd SECRET" run': 'tool --password "[REDACTED]" run',
    'tool --password "abc SECRET\nnext': 'tool --password "[REDACTED]\nnext',
    'tool --password abc"def SECRET" run': "tool --password [REDACTED] run",
    "PGPASSWORD=pa\\$\\$SECRET psql": "PGPASSWORD=[REDACTED] psql",
    'password=ab"cd SECRET" x': "password=[REDACTED] x",
    '\\"password\\": \\"hunter2SECRET" tail': '\\"password\\": \\"[REDACTED]" tail',
    '{"password": "abc\\\\", "user": "bob"}': '{"password": "[REDACTED]", "user": "bob"}',
    "curl -H 'api_key: abc123' https://x.test": "curl -H 'api_key: [REDACTED]' https://x.test",
    // a value inside a quoted string ends where that string does
    "curl 'https://x.test/?token=abc' -H 'api_key: SECRET'": "curl 'https://x.test/?token=[REDACTED]' -H 'api_key: [REDACTED]'",
    '{"a":"https://x/cb?token=abc","password":"my SECRET pw"}': '{"a":"https://x/cb?token=[REDACTED]","password":"[REDACTED]"}',
    'echo "token=abc" && curl -u "admin:my SECRET" https://x': 'echo "token=[REDACTED]" && curl -u "[REDACTED]" https://x',
    '{"id":1,"url":"https://x/?token=abc123","state":"ok","items":[1,2],"msg":"hello world"}':
      '{"id":1,"url":"https://x/?token=[REDACTED]","state":"ok","items":[1,2],"msg":"hello world"}',
    '{\\"url\\":\\"https://x/?token=abc123\\",\\"msg\\":\\"hello world\\"}':
      '{\\"url\\":\\"https://x/?token=[REDACTED]\\",\\"msg\\":\\"hello world\\"}',
    // a stray quote in an unquoted value is part of it
    "DB_PASSWORD=x7'kQ9SECRET psql": "DB_PASSWORD=[REDACTED] psql",
    'https://x/?token=ab"cdSECRET&state=1': "https://x/?token=[REDACTED]&state=1",
    "it's: curl 'https://x.test/?token=abc' -H 'api_key: SECRET' tail": "it's: curl 'https://x.test/?token=[REDACTED]' -H 'api_key: [REDACTED]' tail",
    "it's DB_PASSWORD=x7'kQ9SECRET tail": "it's DB_PASSWORD=[REDACTED] tail",
    "password=\"it's\" api_key=abc'SECRET tail": "password=\"[REDACTED]\" api_key=[REDACTED] tail",
    '{"command":"x\\" curl \\"https://x.test/?token=abc\\" -H \\"api_key: SECRET\\""}':
      '{"command":"x\\" curl \\"https://x.test/?token=[REDACTED]\\" -H \\"api_key: [REDACTED]\\""}',
    "password: 'it''s SECRET' tail": "password: '[REDACTED]' tail",
    // one introducer lying inside the span of another
    'curl -H "X-Api-Key: S3KR1T" -u bob:pw https://x.test': 'curl -H "X-Api-Key: [REDACTED]" -u [REDACTED] https://x.test',
    "curl -d password=S3KR1T --user bob:pw https://x.test": "curl -d password=[REDACTED] --user [REDACTED] https://x.test",
    "docker login --password S3KR1T reg.test -u bob -p x": "docker login --password [REDACTED] reg.test -u bob -p [REDACTED]",
    // "curl … -u" reaches the login's user name too, which errs the safe way
    "curl works but docker login -u bob -p S3KR1T fails": "curl works but docker login -u [REDACTED] -p [REDACTED] fails",
    [`docker --config ${"/a".repeat(40)} login -u bob -p S3KR1T reg.test`]: `docker --config ${"/a".repeat(40)} login -u bob -p [REDACTED] reg.test`,
    // a quoted value in a sentence, and a shell word that goes on after its quoted part
    "Set it with 'password=hunter2'. After that restart; it shouldn't take long.":
      "Set it with 'password=[REDACTED]'. After that restart; it shouldn't take long.",
    'PASSWORD="$BASE"S3KR1T tail': "PASSWORD=[REDACTED] tail",
    "PASSWORD='abc'def tail": "PASSWORD=[REDACTED] tail",
    // a value that ends in backslashes, at the very end of the text
    "password=\\": "password=[REDACTED]",
    "export DB_PASSWORD=a\\": "export DB_PASSWORD=[REDACTED]",
    "tool --password \\\\": "tool --password [REDACTED]",
    // separators inside a URL or header do not end the command
    'curl "https://x.test/?a=1&b=2" -u bob:S3KR1T': 'curl "https://x.test/?a=1&b=2" -u [REDACTED]',
    'curl -H "Accept: text/html;q=0.9" -u bob:S3KR1T': 'curl -H "Accept: text/html;q=0.9" -u [REDACTED]',
    '{"cmd":"the password is Zq9xW7pL","ok":true}': '{"cmd":"the password is [REDACTED]","ok":true}',
    "the password: isn't known to me, and that's fine": "the password: [REDACTED] known to me, and that's fine",
    // a quoted argument, a line continuation or a long argument before the flag
    "curl -H 'Accept: text/html; q=0.9' -u bob:S3KR1T": "curl -H 'Accept: text/html; q=0.9' -u [REDACTED]",
    'curl -d \'{"q": "a & b"}\' -u bob:S3KR1T https://h': 'curl -d \'{"q": "a & b"}\' -u [REDACTED] https://h',
    "docker login -u 'svc; acct' -p S3KR1T reg": "docker login -u 'svc; acct' -p [REDACTED] reg",
    "curl https://h \\\n  --user bob:S3KR1T": "curl https://h \\\n  --user [REDACTED]",
    "docker login reg.test \\\n  -u bob \\\n  -p S3KR1T": "docker login reg.test \\\n  -u bob \\\n  -p [REDACTED]",
    [`curl -d '${"x".repeat(220)}' -u bob:S3KR1T`]: `curl -d '${"x".repeat(220)}' -u [REDACTED]`,
    // Authorization with a scheme that is not one of the well-known ones
    "Authorization: NTLM S3KR1T END": "Authorization: NTLM [REDACTED] END",
    '"authorization": "Splunk S3KR1T"': '"authorization": "Splunk [REDACTED]"',
    "Authorization: abc DB_PASSWORD=S3KR1T": "Authorization: abc [REDACTED]",
    "redis://:S3KR1T@cache.internal:6379": "redis://[REDACTED]@cache.internal:6379",
    // an & inside a value, as opposed to one that starts the next query parameter
    "password: S3C&R3Tzz END": "password: [REDACTED] END",
    "PASSWORD=S3C&R3Tzz": "PASSWORD=[REDACTED]",
    "?token=abc&amp;next=1": "?token=[REDACTED]&amp;next=1",
    // Authorization in prose, in code, padded, and with auth-params
    "Run with `Authorization: Basic dXNlcjpTM0NSM1R6ejk=` and retry": "Run with `Authorization: Basic [REDACTED]` and retry",
    "headers={Authorization=Basic dXNlcjpTM0NSM1R6ejk=, Accept=*/*}": "headers={Authorization=Basic [REDACTED], Accept=*/*}",
    'Authorization: Token token="S3KR1Tzz9"': "Authorization: Token [REDACTED]",
    "headers: { Authorization: `Bearer S3KR1Tzz9` }": "headers: { Authorization: `Bearer [REDACTED]` }",
    // text carried as JSON, where line breaks are written \\n and \\r\\n
    '{"command":"#!/bin/sh\\ncurl -u bob:S3KR1Tzz9 https://h/"}': '{"command":"#!/bin/sh\\ncurl -u [REDACTED] https://h/"}',
    '{"raw":"GET / HTTP/1.1\\r\\nCookie: sid=S3KR1Tzz9\\r\\nHost: h\\r\\n"}': '{"raw":"GET / HTTP/1.1\\r\\nCookie: [REDACTED]\\r\\nHost: h\\r\\n"}',
    '{"out":"key:\\nAKIAIOSFODNN7EXAMPLE"}': '{"out":"key:\\n[REDACTED_AWS]"}',
    '{"out":"x\\nghp_abcdefghijklmnopqrstuvwxyz\\ty"}': '{"out":"x\\n[REDACTED_GH]\\ty"}',
    '{"sh":"a\\ntool --password S3KR1Tzz9\\nb"}': '{"sh":"a\\ntool --password [REDACTED]\\nb"}',
    '{"env":"A=1\\nDB_PASSWORD=S3KR1Tzz9\\nB=2"}': '{"env":"A=1\\nDB_PASSWORD=[REDACTED]\\nB=2"}',
    // assignment operators and a type annotation
    "'password' => 'S3KR1Tzz9',": "'password' => '[REDACTED]',",
    'password := "S3KR1Tzz9"': 'password := "[REDACTED]"',
    'if password == "S3KR1Tzz9":': 'if password == "[REDACTED]":',
    // with a type between the name and the value, the type goes too: telling a
    // type from an unquoted secret is a guess this does not make
    'password: str = "S3KR1Tzz9"': 'password: [REDACTED] = "[REDACTED]"',
    "const apiKey: string = 'S3KR1Tzz9';": "const apiKey: [REDACTED] = '[REDACTED]';",
    'curl -d "{\\"name\\": \\"a; b\\"}" -u bob:S3KR1Tzz9': 'curl -d "{\\"name\\": \\"a; b\\"}" -u [REDACTED]',
    // the same command carried in JSON, where its quotes are escaped
    '{"command":"curl -H \\"Accept: application/json\\" -u user:S3KR1Tzz9 https://x"}': '{"command":"curl -H \\"Accept: application/json\\" -u [REDACTED] https://x"}',
    '{"command":"docker login -u \\"me\\" -p S3KR1Tzz9 reg"}': '{"command":"docker login -u \\"me\\" -p [REDACTED] reg"}',
    // schemes with digits, and schemes that take a parameter list
    "Authorization: SCRAM-SHA-256 S3KR1Tzz9": "Authorization: SCRAM-SHA-256 [REDACTED]",
    "Authorization: AWS4-HMAC-SHA256 Credential=AKID/2015/iam, SignedHeaders=host, Signature=S3KR1Tzz9": "Authorization: AWS4-HMAC-SHA256 [REDACTED]",
    'Authorization: Digest username="u", realm="r", response="S3KR1Tzz9"': "Authorization: Digest [REDACTED]",
    '{"h":"Authorization: Digest username=\\"u\\", response=\\"S3KR1Tzz9\\"\\r\\nHost: h"}': '{"h":"Authorization: Digest [REDACTED]\\r\\nHost: h"}',
    // doubly escaped JSON, and an escaped tab around the operator
    '"{\\"content\\":\\"API_TOKEN=S3KR1Tzz9\\\\ncurl -u admin:S3KR1Tzz8 https://x\\"}"': '"{\\"content\\":\\"API_TOKEN=[REDACTED]\\\\ncurl -u [REDACTED] https://x\\"}"',
    '{"c":"password:\\t\\"S3KR1Tzz9\\""}': '{"c":"password:\\t\\"[REDACTED]\\""}',
    '{"c":"PASSWORD\\t= S3KR1Tzz9"}': '{"c":"PASSWORD\\t= [REDACTED]"}',
    // more type annotations
    'const API_KEY: &str = "S3KR1Tzz9";': 'const API_KEY: [REDACTED] = "[REDACTED]";',
    'val secret: Map<String, String> = "S3KR1Tzz9"': 'val secret: [REDACTED] String> = "[REDACTED]"',
    // a value after a colon is the value, whatever = comes later on the line
    "login({ username: u, password: 'hunter2SECRET' }).then((res) => res.json())": "login({ username: u, password: '[REDACTED]' }).then((res) => res.json())",
    "const cfg = { password: 'hunter2SECRET' }; const x = 1;": "const cfg = { password: '[REDACTED]' }; const x = 1;",
    "password: hunter2SECRET  # default = changeme": "password: [REDACTED]  # default = changeme",
    // names closed by a bracket or a backtick
    "curl -d 'user[password]=hunter2SECRET&user[email]=a@b.c' https://x/login": "curl -d 'user[password]=[REDACTED]&user[email]=a@b.c' https://x/login",
    'os.environ["DB_PASSWORD"] = "hunter2SECRET"': 'os.environ["DB_PASSWORD"] = "[REDACTED]"',
    "config['api_key'] = 'hunter2SECRET'": "config['api_key'] = '[REDACTED]'",
    "UPDATE users SET `password`='hunter2SECRET' WHERE id=1": "UPDATE users SET `password`='[REDACTED]' WHERE id=1",
    'headers["Authorization"] = "Bearer S3KR1Tzz9abc"': 'headers["Authorization"] = "Bearer [REDACTED]"',
    // a credential with no scheme, followed by more text
    "authorization: abc123hunter2SECRET status=200": "authorization: [REDACTED] status=200",
    "authorization: S3KR1Tq7Zx password: S3KR1Tq7Zy": "authorization: [REDACTED] password: [REDACTED]",
    '{"h":"Authorization: Digest\\tusername=\\"u\\", response=\\"S3KR1Tzz9\\""}': '{"h":"Authorization: Digest\\t[REDACTED]"}',
    'Authorization: Digest username = "u", response = "S3KR1Tzz9"': "Authorization: Digest [REDACTED]",
    // JSON values that are not strings
    '{"secret":{"a":"S3KR1Tzz9","b":[1,"x y"]},"keep":"this text"}': '{"secret":[REDACTED],"keep":"this text"}',
    '{"api_keys":["S3KR1Tzz9","S3KR1Tzz8"],"n":1e9,"keep":"this text"}': '{"api_keys":[REDACTED],"n":1e9,"keep":"this text"}',
    '{"max_token":1.5e3,"keep":"this text"}': '{"max_token":[REDACTED],"keep":"this text"}',
    // a JSON literal under a secret-like key is the whole value
    '{"items":[1],"nextPageToken":null,"total":2,"kind":"list","url":"https://x/y"}': '{"items":[1],"nextPageToken":[REDACTED],"total":2,"kind":"list","url":"https://x/y"}',
    '{"reset_password":false,"max_token":4096,"note":"keep me"}': '{"reset_password":[REDACTED],"max_token":[REDACTED],"note":"keep me"}',
    // short flags clustered before -u, and -p with its value attached
    "curl -sSu admin:S3KR1Tzz9 https://x": "curl -sSu [REDACTED] https://x",
    "curl -su 'admin:S3KR1Tzz9' https://x": "curl -su '[REDACTED]' https://x",
    "docker login -pS3KR1Tzz9 reg.test": "docker login -p[REDACTED] reg.test",
    // after NAME=value, a later NAME2=value2 is its own assignment
    "DB_PASSWORD=S3KR1Tzz9 NODE_ENV=production npm start": "DB_PASSWORD=[REDACTED] NODE_ENV=production npm start",
    "host=h password=S3KR1Tzz9 dbname=mydb": "host=h password=[REDACTED] dbname=mydb",
    "PASSWORD=S3KR1Tzz9 make build TARGET=release V=1": "PASSWORD=[REDACTED] make build TARGET=release V=1",
    // flags and names spelled with underscores or a suffix
    "train.py --hf_token S3KR1Tzz9 --epochs 3": "train.py --hf_token [REDACTED] --epochs 3",
    "run --wandb_api_key 'S3KR1Tzz9' x": "run --wandb_api_key '[REDACTED]' x",
    "password=a&password_confirmation=S3KR1Tzz9": "password=[REDACTED]&password_confirmation=[REDACTED]",
    "SECRET_KEY_BASE=S3KR1Tzz9 rails s": "SECRET_KEY_BASE=[REDACTED] rails s",
    "password1=S3KR1Tzz9": "password1=[REDACTED]",
    "curl --proxy-user bob:S3KR1Tzz9 https://x": "curl --proxy-user [REDACTED] https://x",
    // a command or a value continued on the next line, written out and carried in JSON
    "curl -fsSL \\\r\n  -u bob:S3KR1Tzz9 \\\r\n  https://h/": "curl -fsSL \\\r\n  -u [REDACTED] \\\r\n  https://h/",
    [JSON.stringify("curl -fsSL \\\n  -u bob:S3KR1Tzz9 \\\n  https://h/")]: JSON.stringify("curl -fsSL \\\n  -u [REDACTED] \\\n  https://h/"),
    [JSON.stringify(JSON.stringify("docker login -u bob \\\n  -p S3KR1Tzz9 reg"))]: JSON.stringify(JSON.stringify("docker login -u bob \\\n  -p [REDACTED] reg")),
    "mysql --password \\\n  S3KR1Tzz9 db": "mysql --password \\\n  [REDACTED] db",
    "curl -u \\\n  bob:S3KR1Tzz9 https://x": "curl -u \\\n  [REDACTED] https://x",
    "PASSWORD=\\\nS3KR1Tzz9": "PASSWORD=\\\n[REDACTED]",
    // PGP armour
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----": "[REDACTED_PEM]",
    // values that only begin like JSON
    "DB_PASSWORD=[kT9]mQ2xP next": "DB_PASSWORD=[REDACTED] next",
    "password: 2024,Summer! next": "password: [REDACTED] next",
    // a flag after a quoted argument that spans lines
    "curl -X POST https://x -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl -X POST https://x -d '{\n  \"a\": 1\n}' -u [REDACTED]",
    "curl -d '{\n  \"a\": 1\n}' \\\n  -u bob:S3KR1Tzz9": "curl -d '{\n  \"a\": 1\n}' \\\n  -u [REDACTED]",
    "run --password2 S3KR1Tzz9 x": "run --password2 [REDACTED] x",
    "password=[a b]cS3KR1Tzz9 d": "password=[REDACTED] d",
    "password=12}S3KR1Tzz9 next": "password=[REDACTED] next",
    // an apostrophe or a stray quote in prose that names the command does not hide a real one
    "The curl call didn't authenticate.\n\nRetrying:\n\n    curl -u bob:S3KR1Tzz9 https://api.example.com/v1\n\nThat wasn't the problem.":
      "The curl call didn't authenticate.\n\nRetrying:\n\n    curl -u [REDACTED] https://api.example.com/v1\n\nThat wasn't the problem.",
    "docker wasn't logged in\n$ docker login -u bob -p S3KR1Tzz9 reg.io\n$ echo 'ok'": "docker wasn't logged in\n$ docker login -u bob -p [REDACTED] reg.io\n$ echo 'ok'",
    "curl doesn't work here; try curl -u bob:S3KR1Tzz9 'https://x'": "curl doesn't work here; try curl -u [REDACTED] 'https://x'",
    "curl said 'unfinished\ncurl -u bob:S3KR1Tzz9 https://x\necho 'done'": "curl said 'unfinished\ncurl -u [REDACTED] https://x\necho 'done'",
    // a quote attached to a short flag
    "curl -H'Content-Type: application/json' -u bob:S3KR1Tzz9 'https://x'": "curl -H'Content-Type: application/json' -u [REDACTED] 'https://x'",
    "curl -o'out.txt' -u bob:S3KR1Tzz9 'https://x'": "curl -o'out.txt' -u [REDACTED] 'https://x'",
    "curl -H'Accept: x' \\\n  -u bob:S3KR1Tzz9 \\\n  'https://x'": "curl -H'Accept: x' \\\n  -u [REDACTED] \\\n  'https://x'",
    "docker login -u'bob' -p S3KR1Tzz9 'reg'": "docker login -u'bob' -p [REDACTED] 'reg'",
    // the command's name inside an earlier quoted string on the line
    'echo "calling curl"; curl -u bob:S3KR1Tzz9 "https://x"': 'echo "calling curl"; curl -u [REDACTED] "https://x"',
    "alias c='curl -s'; curl -u bob:S3KR1Tzz9 'https://x'": "alias c='curl -s'; curl -u [REDACTED] 'https://x'",
    'echo "az login" && az login -u bob -p S3KR1Tzz9 --tenant "t"': 'echo "az login" && az login -u bob -p [REDACTED] --tenant "t"',
    "Use 'curl' like so: curl -u bob:S3KR1Tzz9 'https://x'": "Use 'curl' like so: curl -u [REDACTED] 'https://x'",
    // the tool's name coming up again in its own arguments
    "docker login docker.io -u bob -p S3KR1Tzz9": "docker login docker.io -u bob -p [REDACTED]",
    "podman login registry.docker.com -u bob -p S3KR1Tzz9": "podman login registry.docker.com -u bob -p [REDACTED]",
    "oc login https://api.oc.example.com:6443 -u kubeadmin -p S3KR1Tzz9": "oc login https://api.oc.example.com:6443 -u kubeadmin -p [REDACTED]",
    "az login --service-principal -u http://az-sp -p S3KR1Tzz9 --tenant t": "az login --service-principal -u http://az-sp -p [REDACTED] --tenant t",
    "curl https://curl.se/x -u bob:S3KR1Tzz9": "curl https://curl.se/x -u [REDACTED]",
    "Curl -u bob:S3KR1Tzz9 https://x": "Curl -u [REDACTED] https://x",
    // a CRLF continuation carried in JSON
    '{"command":"docker login -u bob \\\\\\r\\n  -p S3KR1Tzz9"}': '{"command":"docker login -u bob \\\\\\r\\n  -p [REDACTED]"}',
    '{"command":"curl -s \\\\\\r\\n  -H \\"A: b\\" \\\\\\r\\n  -u bob:S3KR1Tzz9"}': '{"command":"curl -s \\\\\\r\\n  -H \\"A: b\\" \\\\\\r\\n  -u [REDACTED]"}',
    // the other kind of quote inside an open one does not close it
    "curl -H \"User-Agent: Bob's client\" -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9 https://x": "curl -H \"User-Agent: Bob's client\" -d '{\n  \"a\": 1\n}' -u [REDACTED] https://x",
    // a quoted or possessive mention of the tool before a command with a multi-line body
    "Use 'curl' like so:\ncurl -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9 https://h.example/p": "Use 'curl' like so:\ncurl -d '{\n  \"a\": 1\n}' -u [REDACTED] https://h.example/p",
    "curl's output was wrong so retry: curl -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl's output was wrong so retry: curl -d '{\n  \"a\": 1\n}' -u [REDACTED]",
    "curl's output was wrong.\ncurl -d '{\n \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl's output was wrong.\ncurl -d '{\n \"a\": 1\n}' -u [REDACTED]",
    'The "curl" tool: curl -d "{\n  1\n}" -u bob:S3KR1Tzz9': 'The "curl" tool: curl -d "{\n  1\n}" -u [REDACTED]',
    // reach is measured from the command at hand, not from an earlier one on the line
    [`curl -d '${"x".repeat(4100)}' http://a && curl -d '{\n "a": 1\n}' -u bob:S3KR1Tzz9 http://b`]: `curl -d '${"x".repeat(4100)}' http://a && curl -d '{\n "a": 1\n}' -u [REDACTED] http://b`,
    // the tool's name inside one of its own quoted arguments, before a multi-line body
    "curl -H 'User-Agent: curl/8.4.0' -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl -H 'User-Agent: curl/8.4.0' -d '{\n  \"a\": 1\n}' -u [REDACTED]",
    "curl 'https://curl.se/api' -d '{\n  \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl 'https://curl.se/api' -d '{\n  \"a\": 1\n}' -u [REDACTED]",
    'curl "https://curl.se/api" -d "{\n  \\"a\\": 1\n}" -u bob:S3KR1Tzz9': 'curl "https://curl.se/api" -d "{\n  \\"a\\": 1\n}" -u [REDACTED]',
    "curl -d '{\n  \"tool\": \"curl\",\n  \"a\": 1\n}' -u bob:S3KR1Tzz9": "curl -d '{\n  \"tool\": \"curl\",\n  \"a\": 1\n}' -u [REDACTED]",
    "wget 'https://ftp.gnu.org/wget/x' --post-data '{\n \"a\": 1\n}' --user=bob:S3KR1Tzz9": "wget 'https://ftp.gnu.org/wget/x' --post-data '{\n \"a\": 1\n}' --user=[REDACTED]",
    "docker login 'docker.io' --label '{\n \"a\": 1\n}' -u bob -p S3KR1Tzz9": "docker login 'docker.io' --label '{\n \"a\": 1\n}' -u bob -p [REDACTED]",
    // a quoted value attached to the flag, whatever it starts with
    "docker login -u bob -p':S3KR1Tzz9' r.io": "docker login -u bob -p'[REDACTED]' r.io",
    "curl -u':S3KR1Tzz9' https://x": "curl -u'[REDACTED]' https://x",
    'curl -u";S3KR1Tzz9" https://x': 'curl -u"[REDACTED]" https://x',
    // an escaped tab between the flag and its value, in JSON-carried text
    '{"command":"docker login -p\\tS3KR1Tzz9"}': '{"command":"docker login -p\\t[REDACTED]"}',
    '{"command":"curl --user\\tbob:S3KR1Tzz9 https://x"}': '{"command":"curl --user\\t[REDACTED] https://x"}',
    '{"command":"tool --password\\tS3KR1Tzz9 run"}': '{"command":"tool --password\\t[REDACTED] run"}',
    // a quoted value after a stray quote earlier on the line
    "On the admins' box I ran curl -u 'admin:S3KR1Tzz9' https://x": "On the admins' box I ran curl -u '[REDACTED]' https://x",
    "Use James' account: docker login -u james -p 'S3KR1Tzz9' r.io": "Use James' account: docker login -u james -p '[REDACTED]' r.io",
    "the users' login is: curl --user 'admin:S3KR1Tzz9' https://x": "the users' login is: curl --user '[REDACTED]' https://x",
    "In the '90s we ran curl -u 'bob:S3KR1Tzz9' x": "In the '90s we ran curl -u '[REDACTED]' x",
    'Use the 5" drive then curl -u "admin:S3KR1Tzz9" https://x': 'Use the 5" drive then curl -u "[REDACTED]" https://x',
    // a space-separated value in escaped quotes that begins with punctuation
    '{"command":"curl -u \\":S3KR1Tzz9\\" https://dev.azure.com/o/_apis/projects","description":"list"}':
      '{"command":"curl -u \\"[REDACTED]\\" https://dev.azure.com/o/_apis/projects","description":"list"}',
    '{"command":"docker login -u bob -p \\"&S3KR1Tzz9\\" r.io","description":"log in"}':
      '{"command":"docker login -u bob -p \\"[REDACTED]\\" r.io","description":"log in"}',
    'bash -c "docker login -p \\"&S3KR1Tzz9\\" r.io" && true': 'bash -c "docker login -p \\"[REDACTED]\\" r.io" && true',
    // a continuation written with a doubled backslash, as inside a double-quoted script
    'bash -c "set -e\ncurl -s https://x \\\\\n  -u bob:S3KR1Tzz9"': 'bash -c "set -e\ncurl -s https://x \\\\\n  -u [REDACTED]"',
    "docker login r.io \\\\\n  -u bob \\\\\n  -p S3KR1Tzz9": "docker login r.io \\\\\n  -u bob \\\\\n  -p [REDACTED]",
    // a marker from an earlier pattern is kept only when it is the whole value
    "access_token=AKIAIOSFODNN7EXAMPLE": "access_token=[REDACTED_AWS]",
    'password="AKIAIOSFODNN7EXAMPLE:wJalrSECRET"': 'password="[REDACTED]"',
    "password=ghp_abcdefghijklmnopqrstuvwxyz+SECRETTAIL": "password=[REDACTED]",
    "password=`my secret` next": "password=`[REDACTED]` next",
    [`${"x".repeat(200)}_password="SECRET v"`]: `${"x".repeat(200)}_password="[REDACTED]"`,
    "Cookie: session=abc123; theme=dark": "Cookie: [REDACTED]",
    '{"Cookie": "session=abc123"}': '{"Cookie": "[REDACTED]"}',
    '"cookie":"sid=abc"': '"cookie":"[REDACTED]"',
    "curl --user=admin:hunter2 https://x.test": "curl --user=[REDACTED] https://x.test",
    "curl -uadmin:hunter2 https://x.test": "curl -u[REDACTED] https://x.test",
    "id_token: x_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM": "id_token: [REDACTED]",
    "jwt x_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM": "jwt x_[REDACTED_JWT]",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM": "[REDACTED_JWT]",
    "passphrase=correct-horse": "passphrase=[REDACTED]",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(redactString(input), expected, input);
});

test("leaves ordinary prose, paths, URLs and counters alone", () => {
  const untouched = [
    "the token bucket_algorithm limits requests",
    "secret santa-party planning doc",
    "tokens: 15000000 remaining",
    "max_tokens=4096",
    "token_count: 12345",
    "Use Basic authentication for this endpoint",
    "Bearer instruments are transferable",
    "/home/me/projects/sk-learn-experiments-2026",
    "https://example.com:443?email=a@b.com",
    "the access_key_id is public",
    "run with --password-file /etc/pw and --token-count 5",
    "ls -u file:name",
    "docker login registry.test && mkdir -p build/out",
    "ssh login.example.com -p 2222",
    "after login run mkdir -p build/out",
    "{ cookie: req.headers.cookie, user }",
    "Cookie:\nHost: a=b.example",
    "password:\nnextline word",
    "secret:\n  name: x",
    "{ cookie: '[REDACTED]', other: 'x=y' }",
    "curl https://x.test; sort -u a:b",
    "curl https://x.test && id -u bob:x",
    "curl -s https://x.test/up --url https://y.test",
    "curl -ooutput.txt https://x.test",
    // a flag with no value, at the end of a string the command sits in
    '{"command":"curl -s \'https://x/list\' | sort -u","description":"fetch the list","timeout":5}',
    'bash -c "curl -s \'https://x\' | sort -u" && echo done',
    '{"command":"docker login reg && ls -p"} trailing words here',
    "Run `curl -s 'https://x/list' | sort -u` to list them, then pick one and continue.",
    "x=$(curl -s 'https://x' | sort -u); echo done more",
    "Run `curl -s 'https://x/list' | sort -u ` to list them, then pick one.",
    'I ran "curl -s \'https://x\' | sort -u  ". After that it failed.',
    "I ran \"curl -s 'https://x/list' | sort -u\". Then it failed with a 502 and I gave up.",
    '{"command":"n=`curl -s \'https://x/list\' | sort -u`; echo $n","description":"count the names"}',
    '{"command":"bash -c \\"curl -s \'https://x\' | sort -u\\"","description":"fetch it","timeout":5}',
    "jq . | curl https://x.test ; ls -u a:b",
  ];
  for (const text of untouched) assert.equal(redactString(text), text);
});

test("a named secret is removed, and the text after it kept, wherever the form is embedded", () => {
  const word = "S3CR3Tvalue";
  const phrase = "S3CR3T two words";
  const forms = [
    `password=${word}`,
    `api_key: ${word}`,
    `https://x.test/cb?token=${word}&state=1`,
    `tool --password ${word}`,
    `curl -u admin:${word} https://x.test`,
    `docker login -u me -p ${word}`,
    `password="${phrase}"`,
    `client_secret: '${phrase}'`,
    `tool --password "${phrase}"`,
    `{"password":"${phrase}","n":1}`,
  ];
  const contexts = [
    (form) => form,
    (form) => `echo token=abc123 && ${form}`,
    (form) => `curl 'https://x.test/?token=abc123' ; ${form}`,
    (form) => `{"u":"https://x.test/?token=abc123","n":1} ${form}`,
    (form) => `it's here: ${form}`,
    (form) => JSON.stringify({ cmd: form, n: 1 }),
    (form) => JSON.stringify(JSON.stringify({ cmd: form, n: 1 })),
    (form) => (form.includes("'") ? form : `sh -c '${form}'`),
    (form) => (form.includes('"') ? form : `sh -c "${form}"`),
  ];
  // earlier text on the line, including quotes that are never closed
  const prefixes = ["", "it's: ", 'say "hi" then ', "5\" disk, ", 'password="it\'s" ', "a `b "];
  // two forms on one line: neither may shield the other
  for (const first of forms) {
    for (const second of forms) {
      const input = `${first} ${second} KEEPME`;
      const clean = redactString(input);
      assert.doesNotMatch(clean, /S3CR3T|two words/, `${input}\n  -> ${clean}`);
      assert.match(clean, / KEEPME$/, `${input}\n  -> ${clean}`);
    }
  }
  for (const form of forms) {
    for (const [index, embed] of contexts.entries()) {
      for (const prefix of prefixes) {
        const input = `${prefix}${embed(form)} KEEPME`;
        const clean = redactString(input);
        assert.doesNotMatch(clean, /S3CR3T|two words/, `context ${index}: ${input}\n  -> ${clean}`);
        assert.match(clean, / KEEPME$/, `context ${index}: ${input}\n  -> ${clean}`);
      }
    }
  }
});

test("stays linear on long unbroken input", () => {
  // Quadruple the input: linear work takes about 4x as long, quadratic 16x.
  // A ratio holds on a slow machine where a fixed time limit would not.
  const units = {
    letters: "a",
    hex: "0123456789abcdef",
    base64url: "Ab_9-xY_",
    dashes: "token-",
    urls: "a://",
    openQuotes: 'password="',
    looseQuotes: 'password=a" b\\" ',
    backslashes: "password=\\\\",
    jwtStarts: "eyJ-",
    flags: "--password-",
    logins: "docker login ",
    curls: "curl ",
    cookies: "cookie: ",
  };
  const timed = (input) => {
    const started = performance.now();
    redactString(input);
    return performance.now() - started;
  };
  // quoted values whose opening quote is escaped to a different depth on each line
  const escapeDepths = (lines) => Array.from({ length: lines }, (_, depth) => `password=${"\\".repeat(depth % 700)}"x`).join("\n");
  const inputs = Object.entries(units).map(([name, unit]) => {
    const small = unit.repeat(Math.ceil(250_000 / unit.length));
    return [name, small, small.repeat(4)];
  });
  inputs.push(["escapeDepths", escapeDepths(700), escapeDepths(2800)]);
  // commands whose arguments are full of escaped quotes, with no flag to find
  const jsonBody = (fields) => Array.from({ length: fields }, (_, n) => `\\\\\\"k${n}\\\\\\": \\\\\\"v${n}\\\\\\"`).join(", ");
  const carriedCurl = (fields) => `{"command":"curl -s -X POST https://x.test/v1 -H \\"Content-Type: application/json\\" -d \\"{${jsonBody(fields)}}\\""}`;
  inputs.push(["escapedQuotesAfterCurl", `curl ${'\\"'.repeat(60_000)}`, `curl ${'\\"'.repeat(240_000)}`]);
  inputs.push(["escapedQuotesAfterLogin", `docker login ${'\\"'.repeat(60_000)}`, `docker login ${'\\"'.repeat(240_000)}`]);
  inputs.push(["curlCarriedInJson", carriedCurl(3_000), carriedCurl(12_000)]);
  inputs.push(["manyCurls", "curl x ".repeat(40_000), "curl x ".repeat(160_000)]);
  // a long run of backslashes directly after a secret name, and quotes each
  // behind more backslashes than are ever counted
  for (const name of ["password", "authorization", "cookie"]) {
    inputs.push([`${name}ThenBackslashes`, name + "\\".repeat(100_000), name + "\\".repeat(400_000)]);
  }
  const deepQuote = `${"\\".repeat(65)}"`;
  inputs.push(["deepQuotesAfterCurl", `curl ${deepQuote.repeat(2_000)}`, `curl ${deepQuote.repeat(8_000)}`]);
  inputs.push(["deepQuotesInBrackets", `password={${deepQuote.repeat(2_000)}`, `password={${deepQuote.repeat(8_000)}`]);
  // nested brackets that each turn out to be the start of a longer word
  for (const [open, close] of ["[]", "{}"]) {
    const nested = (depth) => `password=${open} `.repeat(depth) + `${close}x `.repeat(depth);
    inputs.push([`nested${open}${close}`, nested(4_000), nested(16_000)]);
  }
  // a command with many quotes that are never closed, each on its own line
  const openQuotes = (lines) => "curl x '\n".repeat(lines);
  inputs.push(["unclosedArguments", openQuotes(20_000), openQuotes(80_000)]);
  // commands with an open quote, followed by lines that all continue
  const continuing = (lines) => "curl 'x\n".repeat(50) + "y \\\n".repeat(lines);
  inputs.push(["openQuotesThenContinuations", continuing(20_000), continuing(80_000)]);
  const longLineAfter = (length) => "curl 'x\n".repeat(200) + "' " + "z ".repeat(length);
  inputs.push(["openQuotesThenLongLine", longLineAfter(100_000), longLineAfter(400_000)]);
  // many continued commands, then a quote left open; and commands that each open one
  for (const tool of ["curl", "docker login"]) {
    const continued = (lines) => `${tool} x \\\n`.repeat(lines) + '"open\nclose" tail\n';
    inputs.push([`${tool} continued`, continued(8_000), continued(32_000)]);
    const opening = (lines) => `${tool} "\\\n`.repeat(lines);
    inputs.push([`${tool} opening`, opening(8_000), opening(32_000)]);
  }
  // one unquoted value that is a long run of backslashes
  // quoted values with ever deeper escaping, all on one line
  const deepening = (blocks) => Array.from({ length: blocks }, (_, depth) => `password=x${"\\".repeat(depth)}"a `).join("");
  inputs.push(["deepening", deepening(700), deepening(1400)]);
  inputs.push(["backslashRun", `token=${"\\".repeat(250_000)}a`, `token=${"\\".repeat(1_000_000)}a`]);
  for (const [name, small, large] of inputs) {
    timed(small); // warm up
    const [fast, slow] = [Math.min(timed(small), timed(small)), Math.min(timed(large), timed(large))];
    assert.ok(slow < 25 || slow / fast < 10, `${name}: ${fast.toFixed(1)} ms for 250 KB but ${slow.toFixed(1)} ms for 1 MB`);
  }
});

test("a secret-named key redacts strings and numbers however deep", () => {
  const clean = redact({
    password: 12345678,
    env: { OPENAI_API_KEY: "abcd1234", aws_secret_access_key: "wJalr", HOME: "/home/me" },
    credentials: { user: "me", remember: true, nested: ["a", 2] },
    Authorization: "Bearer abc",
    passwords: ["p1", "p2"],
    password_confirmation: "p5",
    SECRET_KEY_BASE: "p6",
    secrets: { db: "s1" },
    cookies: { sid: "c1" },
    api_keys: ["k1"],
    "user[password]": "p3",
    "creds[secret][]": ["p4"],
    authorizations: ["Bearer a"],
    total_tokens: 1500,
    max_tokens: 4096,
    tool_input_keys: ["password", "path"],
  });
  assert.deepEqual(clean, {
    password: "[REDACTED]",
    env: { OPENAI_API_KEY: "[REDACTED]", aws_secret_access_key: "[REDACTED]", HOME: "/home/me" },
    credentials: { user: "[REDACTED]", remember: true, nested: ["[REDACTED]", "[REDACTED]"] },
    Authorization: "[REDACTED]",
    passwords: ["[REDACTED]", "[REDACTED]"],
    password_confirmation: "[REDACTED]",
    SECRET_KEY_BASE: "[REDACTED]",
    secrets: { db: "[REDACTED]" },
    cookies: { sid: "[REDACTED]" },
    api_keys: ["[REDACTED]"],
    "user[password]": "[REDACTED]",
    "creds[secret][]": ["[REDACTED]"],
    authorizations: ["[REDACTED]"],
    total_tokens: 1500,
    max_tokens: 4096,
    tool_input_keys: ["password", "path"],
  });
});

test("a __proto__ key is redacted like any other, not dropped", () => {
  const clean = redact(JSON.parse('{"__proto__":{"note":"password=hunter2"},"b":1}'));
  assert.equal(JSON.stringify(clean), '{"__proto__":{"note":"password=[REDACTED]"},"b":1}');
});

test("deep nesting is redacted, never dropped", () => {
  let nested = { note: "password=hunter2" };
  for (let depth = 0; depth < 40; depth++) nested = { child: nested };
  let cursor = redact(nested);
  for (let depth = 0; depth < 40; depth++) cursor = cursor.child;
  assert.deepEqual(cursor, { note: "password=[REDACTED]" });
});

test("summary mode excerpts every nested string after redaction", () => {
  const clean = applyCaptureMode({
    note: "n".repeat(500),
    nested: { transcript: `access_token=${"s".repeat(240)}`, emoji: `${"a".repeat(199)}😀tail` },
  }, "summary");
  assert.equal(clean.note.length, 201);
  assert.equal(clean.nested.transcript, "access_token=[REDACTED]");
  assert.equal(clean.nested.emoji, `${"a".repeat(199)}…`);
});

test("metadata mode keeps allow-listed scalars only", () => {
  const clean = applyCaptureMode({
    session_id: "s1",
    tool: "bash",
    duration_ms: 12,
    model: { id: "m", baseUrl: "http://10.0.0.1" },
    text: "what the agent said",
    cwd: "/work",
  }, "metadata");
  assert.deepEqual(clean, { session_id: "s1", cwd: "/work", tool: "bash", duration_ms: 12 });
});

test("an unknown capture mode is an error, not a silent fall back to full", () => {
  assert.equal(captureMode({}), "full");
  assert.equal(captureMode({ EVENTLOOM_MODE: "Metadata" }), "metadata");
  assert.throws(() => captureMode({ EVENTLOOM_MODE: "metdata" }), /EVENTLOOM_MODE must be one of/);
});
