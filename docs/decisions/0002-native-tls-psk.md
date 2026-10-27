# 0002 · 原生 TLS 1.3 外部 PSK 作为端到端通道

状态：已由 [ADR 0003](0003-desktop-compatible-mtls.md) 取代。真实 Electron/BoringSSL profile 测试证明本方案不兼容 Desktop；以下保留原实验及选择依据，不代表当前协议。

## 决定

两端在 WSS 传递的 Duplex 字节流上运行 TLS 1.3 外部 PSK。邀请携带 32 字节密码学随机秘密；HKDF-SHA256 绑定房间、协议和 guest→host 角色，TLS/OpenSSL 管理握手认证、Finished、记录序号与 AEAD。限定 TLS_AES_128_GCM_SHA256，不接收会话重用材料或证书回退，不启用 keylog。

服务器使用无证书 tls.createServer，并通过公共 connection 事件接入既有 Duplex，绝不调用 listen。客户端保持 rejectUnauthorized:true。成功检查实际 PSK 选择、TLS 版本、cipher、无证书和客户端授权事实；服务器 authorized 是 X509 标志，不将其误当 PSK 判据。

## 实验依据

Bundled Node 24.21.0 / OpenSSL 3.5.8 上，16 个真实 loopback/intermediary/generic Duplex 测试覆盖双向数据、错误秘密/身份/角色、TLS 1.2 降级拒绝、超时、abort、早期关闭、握手与双向密文篡改、重连 exporter 密钥不同。错误秘密失败为 ERR_SSL_BINDER_DOES_NOT_VERIFY，错误身份不能降级到证书。

直接 new TLSSocket 的 server 路径虽可握手，但 Node 尚未交出内部控制权时，AEAD 失败只发私有错误事件。采用 createServer 的公共生命周期避免依赖 _releaseControl/_tlsError；测试包含握手后密文篡改和真实销毁。

另有两个真实房间端点经 Node WebSocket relay / TLS PSK / RPC / DSH fs 纵切测试，覆盖一次房主批准、读写、越界拒绝、禁止访客批准、撤权和双房间身份隔离。不将这些进程内双端测试描述为已通过双 DSH profile/真实 Cloudflare 部署。

## 限制

PSK 证明对方持邀请秘密，不区分同一秘密的多个持有人，也不提供真人身份。对端认证不等于能力授权。秘密不得发给中继、放日志或持久化布局。Fragment 不保护聊天转发、剪贴板或浏览历史。

原生 TLS 删除了自行设计 X25519/HMAC/nonce 协议的义务，但 Duplex 的有界传输、relay 队列、取消、grant、心跳和资源回收仍由插件负责。必须扩展目标 Node/OpenSSL 与 OS 验证矩阵；不能仅以本机通过称其为安全审计。

为在解码前拒绝恶意 relay 的巨型 WebSocket 消息，适配器采用带 maxPayload 的 ws。Node 全局 WebSocket 不能提供这一提前拒绝能力，故不坚持零依赖目标。
