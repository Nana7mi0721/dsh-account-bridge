"""
**独立复核** qoder COSY 的定标向量（test/fixtures/qoder-cosy-vector.json）。

用法（本机 GBK 控制台，必须写成 .py 文件再跑）：

    export PYTHONIOENCODING=utf-8
    python test/fixtures/gen-qoder-cosy-vector.py

向量的**生成**在 `refresh-qoder-vector.mjs`（它要拿到 Node 侧真实的
RSA-PKCS1v1.5 密文，而那是带随机填充、不可复现的）。这个脚本是
**第二实现**：用 Python 独立算一遍，逐条比对上一步写下的向量。

为什么要第二实现：签名这种"照着逆向抄一遍"的东西，同一份理解抄两遍会犯同样的
错——只有换个语言、换个库再算一次，才能把"我抄对了"和"我理解对了"分开。

复核的三件事，正好覆盖 COSY 的三个机制：

1. **AES-128-CBC**（key=iv=固定值，PKCS#7）：`infoB64` 必须逐字节相同；
2. **RSA-PKCS1v1.5**：`cosyKey` 是随机填充的密文，**比不了**——改成自己
   现生成一对密钥，加密再解密，断言还原出 `aesKey`（这正是"确定"的那部分
   性质）。**不读任何提交在仓库里的私钥**：本仓库的主题就是凭据处理，
   源码树里躺一个 `BEGIN PRIVATE KEY` 块既会被 secret scanner 拦，也是在
   给读者做坏示范。实测"我们交给上游的那串密文能解回 aesKey"由
   `test/qoder.test.js` 的往返用例负责（同样现生成密钥对）。
3. **签名公式**：`md5(payloadB64 \n cosyKey \n timestamp \n body \n sigPath)`
   独立复算，必须等于向量里的签名。

依赖：`cryptography`（本机 anaconda 自带）。没有的话：
    pip install cryptography
"""

import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

HERE = os.path.dirname(os.path.abspath(__file__))


def aes_cbc_b64(plaintext: str, key: str) -> str:
    """AES-128-CBC(key=key, iv=key) + PKCS#7，与 Node 的 createCipheriv 默认一致。"""
    key_bytes = key.encode("utf-8")
    raw = plaintext.encode("utf-8")
    pad = 16 - (len(raw) % 16)
    padded = raw + bytes([pad]) * pad
    encryptor = Cipher(algorithms.AES(key_bytes), modes.CBC(key_bytes)).encryptor()
    return base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode("ascii")


def check(label: str, actual, expected) -> None:
    if actual != expected:
        print(f"FAIL {label}\n  python:   {actual}\n  vector:   {expected}")
        sys.exit(1)
    print(f"ok   {label}")


def main() -> None:
    with open(os.path.join(HERE, "qoder-cosy-vector.json"), "r", encoding="utf-8") as handle:
        vector = json.load(handle)

    # 1) AES 段：确定性，逐字节比对。
    check("infoB64 (AES-128-CBC, key=iv)", aes_cbc_b64(vector["userInfoJson"], vector["aesKey"]), vector["infoB64"])

    # 2) RSA 段：密文不可复现，所以断言的是**可逆性**——现生成一对密钥，
    #    加密再解回原文。这也是"每次调用密文都不同"的原因所在。
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    public_key = private_key.public_key()
    ciphertext = public_key.encrypt(vector["aesKey"].encode("utf-8"), padding.PKCS1v15())
    check("RSA-PKCS1v1.5 round-trips to aesKey", private_key.decrypt(ciphertext, padding.PKCS1v15()).decode("utf-8"), vector["aesKey"])
    check("RSA-PKCS1v1.5 is non-deterministic", public_key.encrypt(b"x", padding.PKCS1v15()) == public_key.encrypt(b"x", padding.PKCS1v15()), False)

    # 3) 签名：把 cosyKey 当输入，独立复算。
    payload_b64 = base64.b64encode(
        json.dumps(
            {
                "version": "v1",
                "requestId": vector["requestId"],
                "info": vector["infoB64"],
                "cosyVersion": "1.1.47",
                "ideVersion": "",
            },
            separators=(",", ":"),
        ).encode("utf-8")
    ).decode("ascii")
    check("payloadB64", payload_b64, vector["payloadB64"])

    sig_input = "\n".join([payload_b64, vector["cosyKey"], vector["timestamp"], vector["body"], vector["sigPath"]])
    check("sigInput", sig_input, vector["sigInput"])
    sig = hashlib.md5(sig_input.encode("utf-8")).hexdigest()
    check("signature (md5 over sigInput)", f"Bearer COSY.{payload_b64}.{sig}", vector["authorization"])

    print("\nall checks passed")


if __name__ == "__main__":
    main()
