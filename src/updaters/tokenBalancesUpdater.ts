import { Reducer, useEffect, useMemo, useReducer, useRef } from 'react';
import { useWallet } from 'use-wallet';
import { useSignerContext } from '../context/SignerProvider';
import { ERC20DetailedFactory } from '../typechain/ERC20DetailedFactory';
import {
  useSubscribedTokens,
  useTokensDispatch,
} from '../context/TokensProvider';
import { ERC20Detailed } from '../typechain/ERC20Detailed.d';
import { useKnownAddress } from '../context/KnownAddressProvider';
import { ContractNames } from '../types';

interface State {
  [tokenAddress: string]: ERC20Detailed;
}

enum Actions {
  SetContracts,
  Reset,
}

type Action =
  | {
      type: Actions.SetContracts;
      payload: Record<string, ERC20Detailed>;
    }
  | { type: Actions.Reset };

const initialState: State = {};

const reducer: Reducer<State, Action> = (state, action) => {
  switch (action.type) {
    case Actions.SetContracts:
      return { ...state, ...action.payload };
    case Actions.Reset:
      return {};
    default:
      throw new Error('Unhandled action type');
  }
};

/**
 * Updater for tracking token balances, performing fetches on each new
 * block, and keeping contract instances in state.
 */
export const TokenBalancesUpdater = (): null => {
  const { reset, updateBalances, updateAllowance } = useTokensDispatch();
  const signer = useSignerContext();
  const mUSDAddress = useKnownAddress(ContractNames.mUSD);
  const mUSDSavingsAddress = useKnownAddress(ContractNames.mUSDSavings);

  const mUSD = useMemo(
    () =>
      mUSDAddress && signer
        ? ERC20DetailedFactory.connect(mUSDAddress, signer)
        : null,
    [mUSDAddress, signer],
  );

  const [contracts, dispatch] = useReducer(reducer, initialState);

  const { account, getBlockNumber } = useWallet();
  const accountRef = useRef<string | null>(account);

  const blockNumber = getBlockNumber();
  const blockNumberRef = useRef<number>(blockNumber);

  const subscribedTokens = useSubscribedTokens();

  // Tokens which are subscribed to, but don't have contract instances.
  const missing = useRef<string[]>([]);
  useEffect(() => {
    missing.current = subscribedTokens.filter(token => !contracts[token]);
  }, [subscribedTokens, contracts]);

  // Set missing contract instances.
  useEffect(() => {
    if (!signer || missing.current.length === 0) return;

    const instances = missing.current.reduce(
      (_contracts, token) => ({
        ..._contracts,
        [token]: ERC20DetailedFactory.connect(token, signer),
      }),
      {},
    );

    dispatch({ type: Actions.SetContracts, payload: instances });
  }, [signer, missing]);

  // Update subscribed tokens on each block, and also if the account changes
  useEffect(() => {
    if (
      account && blockNumber &&
      (blockNumberRef.current !== blockNumber || accountRef.current !== account)
    ) {
      // Update balances
      const balancePromises = subscribedTokens
        .filter(token => contracts[token] && token !== mUSDSavingsAddress)
        .map(async token => ({
          [token]: await contracts[token].balanceOf(account),
        }));

      // Update mUSD allowances
      if (mUSDAddress) {
        const allowancePromises = subscribedTokens
          .filter(token => contracts[token] && token !== mUSDAddress)
          .map(async token => ({
            [token]: await contracts[token].allowance(account, mUSDAddress),
          }));

        if (mUSDSavingsAddress && mUSD) {
          mUSD.allowance(account, mUSDSavingsAddress).then(allowance => {
            updateAllowance(mUSDSavingsAddress, { [mUSDAddress]: allowance });
          });
        }

        Promise.all(allowancePromises).then(result => {
          updateAllowance(
            mUSDAddress,
            result.reduce((acc, obj) => ({ ...acc, ...obj }), {}),
          );
        });
      }

      Promise.all(balancePromises).then(result => {
        updateBalances(result.reduce((acc, obj) => ({ ...acc, ...obj }), {}));
        blockNumberRef.current = blockNumber;
      });
    }
  }, [
    account,
    blockNumber,
    blockNumberRef,
    contracts,
    subscribedTokens,
    mUSDAddress,
    mUSD,
    mUSDSavingsAddress,
    updateAllowance,
    updateBalances,
  ]);

  // Clear all contracts and tokens if the account changes.
  useEffect(() => {
    if (accountRef.current !== account) {
      dispatch({ type: Actions.Reset });
      reset();
      accountRef.current = account;
    }
  }, [account, accountRef, reset]);

  return null;
};