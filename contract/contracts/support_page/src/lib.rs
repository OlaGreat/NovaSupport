#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

const LEDGERS_TO_LIVE: u32 = 100_000;
const LEDGERS_THRESHOLD: u32 = 50_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // Input validation errors (1-99)
    ZeroAmount = 2,
    NegativeAmount = 3,
    EmptyMessage = 4,
    MessageTooLong = 5,
    InvalidAssetCode = 6,

    // Authorization errors (100-199)
    NotRecipient = 102,

    // Contract state errors (200-299)
    ContractPaused = 200,
    ContractNotInitialized = 201,
    AlreadyInitialized = 202,

    // Balance and transfer errors (300-399)
    InsufficientBalance = 300,
    InsufficientContractBalance = 301,
    WithdrawAmountExceedsBalance = 303,

    // Storage and data errors (400-499)
    RecipientNotFound = 402,
    ZeroBalance = 403,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    SupportCount,
    RecipientCount(Address),
    RecipientTotal(Address, Address), // (Recipient, Asset)
    Admin,
    Paused,
}

#[derive(Clone)]
#[contracttype]
pub struct SupportEvent {
    pub supporter: Address,
    pub recipient: Address,
    pub amount: i128,
    pub asset_code: String,
    pub message: String,
    pub timestamp: u64,
}

#[contract]
pub struct SupportPageContract;

#[contractimpl]
impl SupportPageContract {
    pub fn initialize(e: Env, admin: Address) -> Result<(), Error> {
        // Check if already initialized
        if e.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        
        admin.require_auth();
        
        e.storage().persistent().set(&DataKey::Admin, &admin);
        e.storage()
            .persistent()
            .extend_ttl(&DataKey::Admin, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);
        e.storage().persistent().set(&DataKey::Paused, &false);
        e.storage()
            .persistent()
            .extend_ttl(&DataKey::Paused, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);
        
        Ok(())
    }

    pub fn pause(e: Env) -> Result<(), Error> {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(Error::ContractNotInitialized)?;
    admin.require_auth();

    e.storage().persistent().set(&DataKey::Paused, &true);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Paused, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

    e.events()
        .publish((symbol_short!("pause"), admin), e.ledger().timestamp());

    Ok(())
}

pub fn unpause(e: Env) -> Result<(), Error> {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(Error::ContractNotInitialized)?;
    admin.require_auth();

    e.storage().persistent().set(&DataKey::Paused, &false);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Paused, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

    e.events()
        .publish((symbol_short!("unpause"), admin), e.ledger().timestamp());

    Ok(())
}
    pub fn support(
        e: Env,
        s: Address,
        r: Address,
        asset: Address,
        o: i128,
        c: String,
        m: String,
    ) -> Result<u32, Error> {
        s.require_auth();

        // Check if contract is initialized
        if !e.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::ContractNotInitialized);
        }

        // Check if contract is paused
        let paused: bool = e
            .storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::ContractPaused);
        }

        // Validate amount
        if o < 0 {
            return Err(Error::NegativeAmount);
        }
        if o == 0 {
            return Err(Error::ZeroAmount);
        }

        // Validate message length (max 280 characters like Twitter)
        if m.len() == 0 {
            return Err(Error::EmptyMessage);
        }
        if m.len() > 280 {
            return Err(Error::MessageTooLong);
        }

        // Validate asset code
        if c.len() == 0 || c.len() > 12 {
            return Err(Error::InvalidAssetCode);
        }

        // Checks: call balance() on the (potentially untrusted) asset contract
        // here — at function entry, before any storage reads or writes — so that
        // a malicious token's re-entrant call into support() finds no partially-
        // updated state to exploit.  This is the first and only external call
        // before the Effects block.
        let client = soroban_sdk::token::Client::new(&e, &asset);
        let supporter_balance = client.balance(&s);
        if supporter_balance < o {
            return Err(Error::InsufficientBalance);
        }

        // Effects: update all counters BEFORE the external token transfer (CEI)
        let st = e.storage().persistent();
        let ct: u32 = st.get(&DataKey::SupportCount).unwrap_or(0);
        let nct = ct + 1;
        st.set(&DataKey::SupportCount, &nct);
        st.extend_ttl(&DataKey::SupportCount, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

        let rct: u32 = st.get(&DataKey::RecipientCount(r.clone())).unwrap_or(0);
        let nrct = rct + 1;
        st.set(&DataKey::RecipientCount(r.clone()), &nrct);
        st.extend_ttl(
            &DataKey::RecipientCount(r.clone()),
            LEDGERS_THRESHOLD,
            LEDGERS_TO_LIVE,
        );

        let total_key = DataKey::RecipientTotal(r.clone(), asset.clone());
        let total: i128 = st.get(&total_key).unwrap_or(0);
        st.set(&total_key, &(total + o));
        st.extend_ttl(&total_key, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

        let tt = symbol_short!("support");
        let ev = SupportEvent {
            supporter: s.clone(),
            recipient: r.clone(),
            amount: o,
            asset_code: c,
            message: m,
            timestamp: e.ledger().timestamp(),
        };
        e.events().publish((tt,), ev);

        // Interaction: transfer tokens LAST (checks-effects-interactions)
        client.transfer(&s, &e.current_contract_address(), &o);

        Ok(nct)
    }

    pub fn withdraw(
        e: Env,
        caller: Address,
        recipient: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        
        // Check if contract is initialized
        if !e.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::ContractNotInitialized);
        }

        // Check if contract is paused
        let paused: bool = e.storage().persistent().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            return Err(Error::ContractPaused);
        }
        
        // Only recipient can withdraw their funds
        if caller != recipient {
            return Err(Error::NotRecipient);
        }

        // Validate amount
        if amount < 0 {
            return Err(Error::NegativeAmount);
        }
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }

        // Checks: call balance() on the (potentially untrusted) asset contract
        // here — at function entry, before any storage reads or writes — so that
        // a malicious token's re-entrant call into withdraw() finds no partially-
        // updated state to exploit.  This is the first and only external call
        // before the Effects block.
        let client = soroban_sdk::token::Client::new(&e, &asset);
        let contract_balance = client.balance(&e.current_contract_address());
        if contract_balance < amount {
            return Err(Error::InsufficientContractBalance);
        }

        let st = e.storage().persistent();
        let key = DataKey::RecipientTotal(recipient.clone(), asset.clone());

        // Distinguish a recipient the contract has never seen from a known
        // recipient whose balance has already been withdrawn to zero.
        if !st.has(&key) {
            return Err(Error::RecipientNotFound);
        }
        let balance: i128 = st.get(&key).unwrap_or(0);

        if balance == 0 {
            return Err(Error::ZeroBalance);
        }

        // Check if withdrawal amount exceeds available balance
        if amount > balance {
            return Err(Error::WithdrawAmountExceedsBalance);
        }

        // Effects: update storage BEFORE the external token transfer (CEI)
        st.set(&key, &(balance - amount));
        st.extend_ttl(&key, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

        // Emit a withdraw event
        e.events()
            .publish((symbol_short!("withdraw"), caller.clone(), asset.clone()), amount);

        // Interaction: transfer tokens LAST (checks-effects-interactions)
        client.transfer(&e.current_contract_address(), &recipient, &amount);

        Ok(())
    }

    pub fn support_count(e: Env) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::SupportCount)
            .unwrap_or(0)
    }

    pub fn recipient_count(e: Env, r: Address) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::RecipientCount(r))
            .unwrap_or(0)
    }

    pub fn get_recipient_total(e: Env, r: Address, asset: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::RecipientTotal(r, asset))
            .unwrap_or(0)
    }

    pub fn get_total_by_asset(e: Env, r: Address, asset: Address) -> i128 {
        Self::get_recipient_total(e, r, asset)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    #[test]
    fn tracks_total_amount_per_recipient() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_000_i128);

        client.initialize(&admin);

        let _ = client.support(
            &supporter,
            &recipient,
            &asset,
            &5_000_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "First support"),
        );
        let _ = client.support(
            &supporter,
            &recipient,
            &asset,
            &3_000_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Second support"),
        );

        assert_eq!(
            client.get_total_by_asset(&recipient, &asset),
            8_000_000_i128
        );
        assert_eq!(client.get_recipient_total(&recipient, &asset), 8_000_000_i128);
    }

    #[test]
    fn keeps_totals_independent_per_recipient_and_asset() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient_one = Address::generate(&e);
        let recipient_two = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset_one = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let asset_two = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin_one = soroban_sdk::token::StellarAssetClient::new(&e, &asset_one);
        let token_admin_two = soroban_sdk::token::StellarAssetClient::new(&e, &asset_two);
        token_admin_one.mint(&supporter, &10_000_000_i128);
        token_admin_two.mint(&supporter, &10_000_000_i128);

        client.initialize(&admin);

        let _ = client.support(
            &supporter,
            &recipient_one,
            &asset_one,
            &4_000_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support one"),
        );
        let _ = client.support(
            &supporter,
            &recipient_two,
            &asset_two,
            &7_000_000_i128,
            &String::from_str(&e, "USDC"),
            &String::from_str(&e, "Support two"),
        );

        assert_eq!(
            client.get_total_by_asset(&recipient_one, &asset_one),
            4_000_000_i128
        );
        assert_eq!(
            client.get_total_by_asset(&recipient_two, &asset_two),
            7_000_000_i128
        );
    }

    #[test]
    fn successful_withdraw() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        // Initial support
        client.support(
            &supporter,
            &recipient,
            &asset,
            &10_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support"),
        );

        assert_eq!(client.get_total_by_asset(&recipient, &asset), 10_000_i128);
        assert_eq!(client.get_recipient_total(&recipient, &asset), 10_000_i128);

        // Withdraw half
        client.withdraw(&recipient, &recipient, &asset, &5_000_i128);

        assert_eq!(client.get_total_by_asset(&recipient, &asset), 5_000_i128);
        assert_eq!(client.get_recipient_total(&recipient, &asset), 5_000_i128);

        // Verify token balance of recipient
        let token_client = soroban_sdk::token::Client::new(&e, &asset);
        assert_eq!(token_client.balance(&recipient), 5_000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #102)")] // Error::NotRecipient
    fn unauthorized_withdraw() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let attacker = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &10_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support"),
        );

        // Attacker tries to withdraw recipient's funds
        client.withdraw(&attacker, &recipient, &asset, &5_000_i128);
    }

    #[test]
    fn supporter_count_tracks_independently_per_recipient() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter_one = Address::generate(&e);
        let supporter_two = Address::generate(&e);
        let recipient_one = Address::generate(&e);
        let recipient_two = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter_one, &10_000_i128);
        token_admin.mint(&supporter_two, &10_000_i128);

        client.initialize(&admin);

        client.support(
            &supporter_one,
            &recipient_one,
            &asset,
            &1_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "For recipient one"),
        );
        client.support(
            &supporter_two,
            &recipient_two,
            &asset,
            &2_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "For recipient two"),
        );

        assert_eq!(client.recipient_count(&recipient_one), 1);
        assert_eq!(client.recipient_count(&recipient_two), 1);
    }

    #[test]
    fn supporter_count_returns_zero_for_unknown_recipient() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let never_supported = Address::generate(&e);

        assert_eq!(client.recipient_count(&never_supported), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #200)")] // Error::ContractPaused
    fn support_fails_when_contract_is_paused() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.pause();

        client.support(
            &supporter,
            &recipient,
            &asset,
            &1_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Should be blocked"),
        );
    }

    #[test]
    fn support_succeeds_after_unpause() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.pause();
        client.unpause();

        let count = client.support(
            &supporter,
            &recipient,
            &asset,
            &1_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "After unpause"),
        );
        assert_eq!(count, 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #303)")] // Error::WithdrawAmountExceedsBalance
    fn over_withdraw() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &10_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support"),
        );

        // Fund the contract with more real tokens than the recipient's
        // recorded total, so the external balance() check (which now runs
        // first — see the reentrancy fix in #1040) passes and the withdrawal
        // is rejected for exceeding the *recorded* total, not the contract's
        // real token balance.
        token_admin.mint(&contract_id, &5_000_i128);

        // Try to withdraw more than the recorded total
        client.withdraw(&recipient, &recipient, &asset, &15_000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // Error::ZeroAmount
    fn support_with_zero_amount() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &0_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Zero amount support"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")] // Error::NegativeAmount
    fn support_with_negative_amount() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &-1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Negative amount support"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")] // Error::MessageTooLong
    fn support_with_long_message() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        // Create a message longer than 280 characters
        let long_message = "a".repeat(281);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, &long_message),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")] // Error::InvalidAssetCode
    fn support_with_empty_asset_code() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, ""),
            &String::from_str(&e, "Support with empty asset code"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #201)")] // Error::ContractNotInitialized
    fn support_without_initialization() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        // Don't initialize the contract
        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support without init"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #202)")] // Error::AlreadyInitialized
    fn double_initialization() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let admin = Address::generate(&e);

        client.initialize(&admin);
        // Try to initialize again
        client.initialize(&admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #402)")] // Error::RecipientNotFound
    fn withdraw_with_no_balance() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);

        client.initialize(&admin);

        // Fund the contract directly (bypassing support()) so the external
        // balance() check — which now runs first, see the reentrancy fix in
        // #1040 — passes, and the withdrawal is rejected because this
        // recipient has no recorded total, not because the contract lacks
        // real tokens.
        token_admin.mint(&contract_id, &1000_i128);

        // Try to withdraw without any support received
        client.withdraw(&recipient, &recipient, &asset, &1000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #403)")] // Error::ZeroBalance
    fn withdraw_again_after_full_withdrawal_is_zero_balance_not_not_found() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &10_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support"),
        );

        // Withdraw everything, then withdraw again - this recipient is known
        // to the contract, so the second call must be ZeroBalance, not
        // RecipientNotFound.
        client.withdraw(&recipient, &recipient, &asset, &10_000_i128);

        // Fund the contract directly (bypassing support()) so the external
        // balance() check — which now runs first, see the reentrancy fix in
        // #1040 — passes, and the second withdrawal is rejected because this
        // recipient's recorded total is zero, not because the contract lacks
        // real tokens.
        token_admin.mint(&contract_id, &1_i128);
        client.withdraw(&recipient, &recipient, &asset, &1_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #301)")] // Error::InsufficientContractBalance
    fn withdraw_fails_when_contract_token_balance_is_below_recorded_total() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &1_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Support"),
        );

        // Inflate the recorded total beyond what the contract actually
        // holds in tokens, simulating the contract's own balance falling
        // below a recipient's recorded total.
        e.as_contract(&contract_id, || {
            e.storage().persistent().set(
                &DataKey::RecipientTotal(recipient.clone(), asset.clone()),
                &1_000_000_i128,
            );
        });

        client.withdraw(&recipient, &recipient, &asset, &1_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")] // Error::EmptyMessage
    fn support_with_empty_message() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, ""),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #300)")] // Error::InsufficientBalance
    fn support_with_insufficient_balance() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &100_i128);

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &10_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "More than balance"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // Error::ZeroAmount
    fn withdraw_zero_amount() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &5_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Setup support"),
        );

        client.withdraw(&recipient, &recipient, &asset, &0_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")] // Error::NegativeAmount
    fn withdraw_negative_amount() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &5_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Setup support"),
        );

        client.withdraw(&recipient, &recipient, &asset, &-1000_i128);
    }

    #[test]
    #[should_panic]
    fn non_admin_cannot_unpause() {
        let e = Env::default();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let admin = Address::generate(&e);

        client.initialize(&admin);
        client.pause();
        // Auth not mocked for admin, so unpause should fail
        client.unpause();
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #201)")] // Error::ContractNotInitialized
    fn pause_without_initialization() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        client.pause();
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #201)")] // Error::ContractNotInitialized
    fn withdraw_without_initialization() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let recipient = Address::generate(&e);
        let asset = Address::generate(&e);

        client.withdraw(&recipient, &recipient, &asset, &1000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")] // Error::InvalidAssetCode
    fn support_with_too_long_asset_code() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let admin = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "TOOLONGASSETCO"),
            &String::from_str(&e, "Support with too-long asset code"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #200)")] // Error::ContractPaused
    fn withdraw_fails_when_contract_is_paused() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(SupportPageContract, ());
        let client = SupportPageContractClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let supporter = Address::generate(&e);
        let recipient = Address::generate(&e);
        let asset = e
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&e, &asset);
        token_admin.mint(&supporter, &10_000_i128);

        client.initialize(&admin);

        // Fund the recipient so withdraw has a balance
        client.support(
            &supporter,
            &recipient,
            &asset,
            &5_000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, "Pre-withdraw support"),
        );

        client.pause();

        // Withdraw while paused must fail
        client.withdraw(&recipient, &recipient, &asset, &1_000_i128);
    }
}
