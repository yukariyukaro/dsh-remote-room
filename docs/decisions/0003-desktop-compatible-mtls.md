# 0003 · Desktop 与 Web 共用的 TLS 1.3 双向证书认证

状态：取代 ADR 0002 的外部 PSK 方案；双运行时实验通过，生产模块与真实应用组合正在迁移验收。

## 实际平台差异

独立 Node 24.21.0 / OpenSSL 3.5.8 的真实通道测试通过，不能代表 Desktop 兼容。0.1.1 分发包经支持的 Desktop CLI carrier，在两个隔离 web profile 安装和启动成功，但 Electron 44.7.0 的 BoringSSL 无证书 TLS 1.3 PSK 服务端失败为 `NO_CERTIFICATE_SET`。它不是网络不通，也不是允许关闭认证的理由。

## 替代决定

使用标准 TLS 1.3 双向证书认证。每个房间通过原生 WebCrypto 随机生成 P-256 密钥，使用维护中的 `@peculiar/x509` 生成房间专用自签证书。邀请 v2 在 fragment 中携带证书 DER 与 PKCS8 DER；这是 bearer credential，不是设备身份。双方以该证书为唯一 CA，并要求对端呈现同一份精确 DER 证书、完成私钥证明，另检查 ALPN 与 room/protocol 绑定、hostname、有效期和双方 `authorized`。只接受 TLS_AES_128_GCM_SHA256，保持双方 `rejectUnauthorized:true`；服务器要求客户端证书。无 TLS 1.2、无 PSK 或系统 CA 回退，不保存 session 或 keylog。

原生 TLS 处理临时密钥交换、证书签名验证、Finished、序号与记录 AEAD；不自行设计加密协议，也不把邀请秘密手工映射成 EC scalar。插件仍使用不监听端口的 `tls.createServer` 接入既有 Duplex。

同一邀请的持有人可以冒充任一角色，语义与原 PSK 一致。精确证书 pin 还拒绝使用邀请 CA 私钥另签的叶证书。证书 hostname 和 ALPN 使用房间/协议的公开 hash，不将私钥放入中继 URL。v1 预发布邀请明确拒绝，用户需重新创建 v2 邀请，不隐式降级。

TLS 1.3 客户端 `secureConnect` 可能早于服务器接受客户端证书。主机只有 `secureConnection` 成功后才挂 RPC；访客必须完成 TLS 内的 hello/ready 和后续房主批准，不能把客户端事件当作双端授权完成。

## 依赖与凭证生命周期

实际依赖为 `@peculiar/x509@2.2.0`、`reflect-metadata@0.2.2`，不引入额外 WebCrypto shim 或 native addon。实验所用闭包为 21 个 package/version 实例、20 个唯一包名，安装源码约 2.3 MB；它删除的是证书编码/签名实现义务，不是所有安全测试义务。

证书身份有效期长于邀请等待时间；真正邀请可用期仍由房主内存中的房间 timer 限定，批准后的授权由 grant 到期/撤权限定，不能用证书有效期取代能力期限。私钥不落盘、不进入 room snapshot 或审计。PEM/URL 的 JavaScript 字符串和原生 TLS 内存不能可靠清零，关闭时只释放引用，不承诺内存安全擦除。邀请不应写入浏览器持久布局、日志或测试报告。

## 实验与验收口径

`scripts/spikes/bore-tls.mjs` 已在独立 OpenSSL Node 与 Electron/BoringSSL 各通过六项真实网络实验：generic Duplex mTLS、双向数据、不同邀请拒绝、未信任客户端拒绝、错误 ALPN 拒绝、两个方向密文篡改后错误与销毁。实验脚本不监听生产端口。

仍需运行新的生产 `tls-channel` 测试、真实已安装双 profile、桌面窗口和 Web 点击旅程。不要把上述实验写成已完成桌面插件验收。原 PSK 的测试与失败记录保留为决策依据，但不作为新协议的通过证据。
