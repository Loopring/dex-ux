import { addHexPrefix, toBuffer, toHex, toNumber } from '../common/formatter';
import {
  ecrecover,
  fromRpcSig,
  hashPersonalMessage,
  keccak256,
  pubToAddress,
} from 'ethereumjs-util';
import ABI from '../ethereum/contracts';
import Transaction from 'ethereumjs-tx';

/**
 * @description sign hash
 * @param web3
 * @param account
 * @param hash
 * @returns {Promise.<*>}
 */
export async function sign(web3, account, hash) {
  return new Promise((resolve) => {
    web3.eth.sign(hash, account, function (err, result) {
      if (!err) {
        console.log('sig result', result);
        const r = result.slice(0, 66);
        const s = addHexPrefix(result.slice(66, 130));
        let v = toNumber(addHexPrefix(result.slice(130, 132)));
        if (v === 0 || v === 1) v = v + 27; // 修复ledger的签名
        resolve({ result: { r, s, v } });
      } else {
        const errorMsg = err.message.substring(0, err.message.indexOf(' at '));
        resolve({ error: { message: errorMsg } });
      }
    });
  });
}

/**
 * @description sign EIP217
 * @param web3
 * @param account
 * @param method
 * @param params
 * @returns {Promise.<*>}
 */
export async function signEip712(web3, account, method, params) {
  const response = await new Promise((resolve) => {
    web3.currentProvider.sendAsync(
      {
        method,
        params,
        account,
      },
      function (err, result) {
        if (err) {
          resolve({ error: { message: err.message } });
          return;
        }

        if (result.error) {
          resolve({ error: { message: result.error.message } });
          return;
        }

        resolve({ result: result.result });
      }
    );
  });

  if (response['result']) {
    return response;
  } else {
    throw new Error(response['error']['message']);
  }
}

/**
 * @description sign message
 * @param web3
 * @param account
 * @param message
 * @returns {Promise}
 */
export async function signMessage(web3, account, message) {
  const hash = toHex(hashPersonalMessage(keccak256(message)));
  return await sign(web3, account, hash);
}

export async function personalSign(web3, account, msg, walletType) {
  return new Promise((resolve) => {

    web3.eth.personal.sign(msg, account, '', async function (err, result) {
      if (!err) {

        // no sign/ecRecover for imtoken
        if (!!window.imToken || (window.ethereum && window.ethereum.isImToken)) {
          resolve({ sig: result });
          return;
        }

        // ecRecover not implemented in WalletLink
        if (walletType === 'WalletLink') {
          const valid = await walletLinkValid(web3, account, msg, result);
          if (valid.result) {
            resolve({ sig: result });
          } else {
            resolve({ error: 'Failed to valid using WalletLink' });
          }
          return;
        }

        if (walletType === 'Authereum') {
          const valid = await authereumValid(web3, account, msg, result);
          if (valid.result) {
            resolve({ sig: result });
          } else {
            resolve({ error: 'invalid sig using Authereum' });
          }
          return;
        }

        const valid = await ecRecover(web3, account, msg, result);
        if (valid.result) {
          resolve({ sig: result });
        } else {
          const walletValid = await contractWalletValidate(
            web3,
            account,
            msg,
            result
          );

          if (walletValid.result) {
            resolve({ sig: result });
          } else {
            const walletValid2 = await contractWalletValidate2(
              web3,
              account,
              msg,
              result
            );

            if (walletValid2.result) {
              resolve({ sig: result });
            } else {
              const myKeyValid = await mykeyWalletValid(
                web3,
                account,
                msg,
                result
              );
              // console.log(JSON.stringify(myKeyValid));

              if (myKeyValid.result) {
                resolve({ sig: result });
              } else {
                resolve({ error: 'invalid sig' });
              }
            }
          }
        }
      } else resolve({ error: err });
    });
  });
}

export async function ecRecover(web3, account, msg, sig) {
  return new Promise((resolve) => {
    web3.eth.personal.ecRecover(msg, sig, function (err, address) {
      if (!err)
        resolve({
          result: address.toLowerCase() === account.toLowerCase(),
        });
      else {
        console.log('in web3.eth.personal.ecRecover', err, address);
        resolve({ error: err });
      }
    });
  });
}

export async function contractWalletValidate(web3, account, msg, sig) {
  return new Promise((resolve) => {
    const hash = hashPersonalMessage(toBuffer(msg));
    const data = ABI.Contracts.ContractWallet.encodeInputs(
      'isValidSignature(bytes,bytes)',
      {
        _data: hash,
        _signature: toBuffer(sig),
      }
    );

    web3.eth.call(
      {
        to: account, // contract addr
        data: data,
      },
      function (err, result) {
        if (!err) {
          const valid = ABI.Contracts.ContractWallet.decodeOutputs(
            'isValidSignature(bytes,bytes)',
            result
          );
          resolve({
            result: toHex(toBuffer(valid[0])) === data.slice(0, 10),
          });
        } else resolve({ error: err });
      }
    );
  });
}

export async function contractWalletValidate2(web3, account, msg, sig) {
  return new Promise((resolve) => {
    const hash = hashPersonalMessage(toBuffer(msg));
    const data = ABI.Contracts.ContractWallet.encodeInputs(
      'isValidSignature(bytes32,bytes)',
      {
        _data: hash,
        _signature: toBuffer(sig),
      }
    );

    web3.eth.call(
      {
        to: account, // contract addr
        data: data,
      },
      function (err, result) {
        console.log(result);
        if (!err) {
          const valid = ABI.Contracts.ContractWallet.decodeOutputs(
            'isValidSignature(bytes32,bytes)',
            result
          );
          resolve({
            result: toHex(toBuffer(valid[0])) === data.slice(0, 10),
          });
        } else resolve({ error: err });
      }
    );
  });
}

export async function mykeyWalletValid(web3, account, msg, sig) {
  const myKeyContract = '0xADc92d1fD878580579716d944eF3460E241604b7';
  return new Promise((resolve) => {
    web3.eth.call(
      {
        to: myKeyContract,
        data: ABI.Contracts.ContractWallet.encodeInputs('getKeyData', {
          _account: account,
          _index: 3,
        }),
      },
      function (err, res) {
        if (!err) {
          const signature = fromRpcSig(sig);
          const hash = hashPersonalMessage(keccak256(toBuffer(msg)));
          const address = addHexPrefix(
            ABI.Contracts.ContractWallet.decodeOutputs('getKeyData', res)[0]
          );
          const recAddress = toHex(
            pubToAddress(ecrecover(hash, signature.v, signature.r, signature.s))
          );
          resolve({
            result: recAddress.toLowerCase() === address.toLowerCase(),
          });
        } else {
          resolve({ error: err });
        }
      }
    );
  });
}

// Authereum account contract hashes the data in the validation function,
// so we must send the data plain text.
export async function authereumValid(web3, account, msg, sig) {
  return new Promise((resolve) => {
    const hash = toBuffer(msg);
    const data = ABI.Contracts.ContractWallet.encodeInputs(
      'isValidSignature(bytes,bytes)',
      {
        _data: hash,
        _signature: toBuffer(sig),
      }
    );

    web3.eth.call(
      {
        to: account, // contract addr
        data: data,
      },
      function (err, result) {
        if (!err) {
          const valid = ABI.Contracts.ContractWallet.decodeOutputs(
            'isValidSignature(bytes,bytes)',
            result
          );
          resolve({
            result: toHex(toBuffer(valid[0])) === data.slice(0, 10),
          });
        } else resolve({ error: err });
      }
    );
  });
}

export async function walletLinkValid(web3, account, msg, sig) {
  return new Promise((resolve) => {
    const signature = fromRpcSig(sig);
    const hash = hashPersonalMessage(toBuffer(msg));
    const recAddress = toHex(
      pubToAddress(ecrecover(hash, signature.v, signature.r, signature.s))
    );
    resolve({
      result: recAddress.toLowerCase() === account.toLowerCase(),
    });
  });
}

/**
 * @description Signs ethereum tx
 * @param web3
 * @param account
 * @param rawTx
 * @returns {Promise.<*>}
 */
export async function signEthereumTx(web3, account, rawTx) {
  const ethTx = new Transaction(rawTx);
  const hash = toHex(ethTx.hash(false));
  const response = await sign(web3, account, hash);
  if (!response['error']) {
    const signature = response['result'];
    signature.v += ethTx.getChainId() * 2 + 8;
    Object.assign(ethTx, signature);
    return { result: toHex(ethTx.serialize()) };
  } else {
    throw new Error(response['error']['message']);
  }
}

/**
 * @description Sends ethereum tx through MetaMask
 * @param web3
 * @param tx
 * @returns {*}
 */
export async function sendTransaction(web3, tx) {
  delete tx.gasPrice;
  // delete tx.gas;
  const response = await new Promise((resolve) => {
    web3.eth.sendTransaction(tx, function (err, transactionHash) {
      if (!err) {
        resolve({ result: transactionHash });
      } else {
        resolve({ error: { message: err.message } });
      }
    });
  });

  if (response['result']) {
    return response;
  } else {
    throw new Error(response['error']['message']);
  }
}

export async function isContract(web3, address) {
  const code = await web3.eth.getCode(address);
  return code && code.length > 2;
}
