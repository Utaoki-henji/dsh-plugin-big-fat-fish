# 项目登录档案与每轮联合测试

用途：登录接口测过一次后按**项目**记住，后续每轮默认「先登录拿令牌，再测本轮功能」；有登录的项目每轮都会多测一次登录。模板中的凭据只写环境变量名，**不写明文**。

## 1. 文件位置

```
.ft/logins/<project>.json        # 项目级，跨轮次复用；一个文件用 environments 区分环境
```

- `<project>`：小写 kebab，例如 `user-center`、`order-admin`。
- 档案由 agent 在用户确认后写入；后续每轮先读档案，再生成联合套件。
- 档案包含登录接口与环境地址（不含凭据值），是否入库按团队规范决定；`.ft/runs/` 仍不入库。

## 2. 档案格式

```jsonc
{
  "schemaVersion": 1,
  "project": "user-center",
  "updatedAt": "2026-10-26T10:00:00+08:00",
  "environments": {
    "test": {
      "baseUrl": "http://test.example.com",
      "credentialEnv": {
        "username": "USER_CENTER_TEST_USERNAME",
        "password": "USER_CENTER_TEST_PASSWORD"
      },
      "login": {
        "caseId": "LOGIN-001",
        "name": "登录并获取令牌",
        "destructive": true,                     // 登录是 POST，需要 destructive.rules 放行
        "request": {
          "method": "POST",
          "path": "/api/auth/login",
          "headers": { "content-type": "application/json" },
          "body": {
            "username": "${env:USER_CENTER_TEST_USERNAME}",
            "password": "${env:USER_CENTER_TEST_PASSWORD}"
          }
        },
        "expect": {
          "status": [200, 201],
          "jsonPath": [{ "path": "$.code", "op": "equals", "value": 0 }]
        },
        "extract": { "accessToken": "$.data.token" }
      },
      "authHeader": {
        "name": "Authorization",
        "prefix": "Bearer ",
        "variable": "accessToken"
      },
      "tokenLifetimeHint": "响应 expiresIn=7200（2h）；每轮重新登录，不缓存令牌"
    }
  },
  "probe": {
    "at": "2026-10-26T10:00:00+08:00",
    "method": "先 POST 空 body 观察 400 必填项，再用测试账号登录成功一次",
    "observed": {
      "missingField": "400 { code: 1001, message: 'username 不能为空' }",
      "successShape": "{ code: 0, data: { token: '...', expiresIn: 7200 } }"
    }
  },
  "register": {
    "note": "可选：若测过注册，记录接口与造数据方式（同样只写变量名）"
  }
}
```

`.ft/config.json` 里要放行登录写操作，例如：

```jsonc
"destructive": {
  "enabled": true,
  "rules": [{ "method": "POST", "pathPattern": "/api/auth/*" }]
}
```

## 3. 凭据来源与本地存储（内部系统不能注册账号）

凭据解析顺序（`${env:NAME}`）：

1. 宿主进程环境变量（启动 Harness 时 export，或系统环境变量）
2. 工作区本地凭据库 `.ft/credentials.local.json`（已加入 `.ft/.gitignore`）

本地凭据库格式：

```jsonc
{
  "schemaVersion": 1,
  "variables": {
    "USER_CENTER_TEST_USERNAME": "tester",
    "USER_CENTER_TEST_PASSWORD": "..."
  }
}
```

规则：
- 只存**测试/开发环境**账号；用户发来账号时先确认是测试还是开发环境，生产账号一律不存、不用。
- 变量名建议 `<PROJECT>_<ENV>_USERNAME` / `_PASSWORD`，避免多项目冲突。
- 文件不入库（`.gitignore` 已含 `credentials.local.json`、`*.local.json`）；不贴报告、不在回复里复述值，只确认「已存储，变量名 XXX」。
- 聊天里发过的明文会留在会话记录中，测试账号也要定期轮换；能用环境变量就优先用环境变量。
- 缺变量时运行期报 `setup_error`（不会静默取空值）。
- 登录档案、套件里只写 `${env:变量名}`，不写值。

## 4. 没有档案、但接口需要令牌时（探测流程）

1. **先问用户**：登录/注册接口的 method + path，有没有接口文档或 Controller；不要猜路径、不要遍历常见路径（避免风控/锁号）。
2. **能读到代码就先只读定位**：登录 Controller、参数 DTO、`@Valid` 规则、统一返回体与错误码。
3. **最少请求探测**：
   - 先发缺字段/空 body，观察必填字段与错误结构（1 次）；
   - 再用测试账号成功登录 1 次，记录状态码、返回体结构、令牌位置、有效期字段；
   - 全程用测试环境账号，避免连续失败触发锁定。
4. **整理后发给用户确认**：登录接口、参数、令牌路径、鉴权头格式、凭据环境变量名；确认后写入 `.ft/logins/<project>.json`。
5. 本轮即可按 §5 联合测试，登录用例计入本轮。

## 5. 每轮联合套件（有登录档案时默认）

```jsonc
{
  "schemaVersion": 1,
  "name": "user-center-round-2",
  "defaults": { "baseUrl": "http://test.example.com" },
  "cases": [
    {
      "id": "LOGIN-001",
      "name": "登录并获取令牌（每轮必测）",
      "destructive": true,
      "request": {
        "method": "POST",
        "path": "/api/auth/login",
        "headers": { "content-type": "application/json" },
        "body": { "username": "${env:USER_CENTER_TEST_USERNAME}", "password": "${env:USER_CENTER_TEST_PASSWORD}" }
      },
      "expect": { "status": [200, 201], "jsonPath": [{ "path": "$.code", "op": "equals", "value": 0 }] },
      "extract": { "accessToken": "$.data.token" }
    },
    {
      "id": "TC-201",
      "name": "本轮功能用例",
      "destructive": false,
      "request": {
        "method": "GET",
        "path": "/api/users/me",
        "headers": { "authorization": "Bearer ${accessToken}" }
      },
      "expect": { "status": 200, "jsonPath": [{ "path": "$.data.id", "op": "exists" }] }
    }
  ]
}
```

规则：
- 登录用例永远放第一条，id 用 `LOGIN-001`，计入本轮用例总数。
- 功能用例的鉴权头用 `${accessToken}`；不要把令牌写进套件文件或聊天里。
- 登录失败时，后续用例的 401/403 归因为**环境/凭据问题**，不判产品缺陷；修好后重跑。
- 令牌出现失效/接口变更（连续两轮登录失败或 401），重新走 §4 探测并更新档案。

## 6. UI 登录态（可选段）

UI 自动化沿用 storageState 复用登录态：

```jsonc
"ui": {
  "baseUrl": "http://test.example.com",
  "storageState": ".ft/auth/user-center-test.json",
  "generatedAt": "2026-10-26T10:00:00+08:00",
  "accountEnv": "USER_CENTER_TEST_UI_USERNAME",
  "note": "登录态过期需重新生成；生成脚本不落凭据明文"
}
```

UI 自动化不需要用户确认测试数据，只需在开跑前告知覆盖的页面/流程/断言点。
