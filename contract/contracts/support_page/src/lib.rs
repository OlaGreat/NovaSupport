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
    InvalidAmount = 1,
    ZeroAmount = 2,
    NegativeAmount = 3,
    EmptyMessage = 4,
    MessageTooLong = 5,
    InvalidAssetCode = 6,
    
    // Authorization errors (100-199)
    Unauthorized = 100,
    NotAdmin = 101,
    NotRecipient = 102,
    CallerNotAuthorized = 103,
    
    // Contract state errors (200-299)
    ContractPaused = 200,
    ContractNotInitialized = 201,
    AlreadyInitialized = 202,
    
    // Balance and transfer errors (300-399)
    InsufficientBalance = 300,
    InsufficientContractBalance = 301,
    TransferFailed = 302,
    WithdrawAmountExceedsBalance = 303,
    
    // Storage and data errors (400-499)
    StorageError = 400,
    DataNotFound = 401,
    RecipientNotFound = 402,
    
    // Asset and token errors (500-599)
    InvalidAsset = 500,
    AssetNotSupported = 501,
    TokenClientError = 502,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    SupportCount,
    RecipientCount(Address),
    RecipientTotal(Address),
    TotalByAsset(Address, Address), // (Recipient, Asset)
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

fn count_utf8_chars(s: &String) -> u32 {
    let byte_len = s.len() as usize;
    if byte_len > 1120 {
        return 281;
    }
    let mut buf = [0u8; 1120];
    s.copy_into_slice(&mut buf[..byte_len]);
    buf[..byte_len].iter().filter(|&&b| (b & 0xC0) != 0x80).count() as u32
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

    // pub fn pause(e: Env) -> Result<(), Error> {
    //     let admin: Address = e
    //         .storage()
    //         .persistent()
    //         .get(&DataKey::Admin)
    //         .ok_or(Error::ContractNotInitialized)?;
    //     admin.require_auth();
        
    //     e.storage().persistent().set(&DataKey::Paused, &true);
    //     e.storage()
    //         .persistent()
    //         .extend_ttl(&DataKey::Paused, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);
    //     Ok(())
    // }

    // pub fn unpause(e: Env) -> Result<(), Error> {
    //     let admin: Address = e
    //         .storage()
    //         .persistent()
    //         .get(&DataKey::Admin)
    //         .ok_or(Error::ContractNotInitialized)?;
    //     admin.require_auth();
        
    //     e.storage().persistent().set(&DataKey::Paused, &false);
    //     e.storage()
    //         .persistent()
    //         .extend_ttl(&DataKey::Paused, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);
    //     Ok(())
    // }
pub fn pause(e: Env) -> Result<(), Error> {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(Error::ContractNotInitialized)?;
    admin.require_auth();

    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Admin, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

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

    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Admin, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

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

        e.storage()
            .persistent()
            .extend_ttl(&DataKey::Admin, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

        // Validate amount
        if o < 0 {
            return Err(Error::NegativeAmount);
        }
        if o == 0 {
            return Err(Error::ZeroAmount);
        }

        // Validate message length (max 280 Unicode code points like Twitter)
        if count_utf8_chars(&m) > 280 {
            return Err(Error::MessageTooLong);
        }

        // Validate asset code
        if c.len() == 0 {
            return Err(Error::InvalidAssetCode);
        }

        // Transfer funds from supporter to contract
        let client = soroban_sdk::token::Client::new(&e, &asset);
        
        // Check supporter balance before transfer
        let supporter_balance = client.balance(&s);
        if supporter_balance < o {
            return Err(Error::InsufficientBalance);
        }
        
        // Transfer tokens - panics on failure per Soroban token contract spec
        client.transfer(&s, &e.current_contract_address(), &o);

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

        let total: i128 = st.get(&DataKey::RecipientTotal(r.clone())).unwrap_or(0);
        st.set(&DataKey::RecipientTotal(r.clone()), &(total + o));
        st.extend_ttl(
            &DataKey::RecipientTotal(r.clone()),
            LEDGERS_THRESHOLD,
            LEDGERS_TO_LIVE,
        );

        let asset_total: i128 = st
            .get(&DataKey::TotalByAsset(r.clone(), asset.clone()))
            .unwrap_or(0);
        st.set(
            &DataKey::TotalByAsset(r.clone(), asset.clone()),
            &(asset_total + o),
        );
        st.extend_ttl(
            &DataKey::TotalByAsset(r.clone(), asset.clone()),
            LEDGERS_THRESHOLD,
            LEDGERS_TO_LIVE,
        );

        let tt = symbol_short!("support");
        let ev = SupportEvent {
            supporter: s,
            recipient: r,
            amount: o,
            asset_code: c,
            message: m,
            timestamp: e.ledger().timestamp(),
        };
        e.events().publish((tt,), ev);
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
        let paused: bool = e
            .storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::ContractPaused);
        }

        e.storage()
            .persistent()
            .extend_ttl(&DataKey::Admin, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

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

        let st = e.storage().persistent();
        let key = DataKey::TotalByAsset(recipient.clone(), asset.clone());
        let balance: i128 = st.get(&key).unwrap_or(0);

        // Check if recipient has any balance for this asset
        if balance == 0 {
            return Err(Error::RecipientNotFound);
        }

        // Check if withdrawal amount exceeds available balance
        if amount > balance {
            return Err(Error::WithdrawAmountExceedsBalance);
        }

        // Check contract's token balance
        let client = soroban_sdk::token::Client::new(&e, &asset);
        let contract_balance = client.balance(&e.current_contract_address());
        if contract_balance < amount {
            return Err(Error::InsufficientContractBalance);
        }

        // Transfer funds from contract to recipient - panics on failure per Soroban token contract spec
        client.transfer(&e.current_contract_address(), &recipient, &amount);

        // Deduct from TotalByAsset storage
        st.set(&key, &(balance - amount));
        st.extend_ttl(&key, LEDGERS_THRESHOLD, LEDGERS_TO_LIVE);

        // Emit a withdraw event
        e.events()
            .publish((symbol_short!("withdraw"), caller, asset), amount);

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

    pub fn get_total_by_asset(e: Env, r: Address, asset: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::TotalByAsset(r, asset))
            .unwrap_or(0)
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

        // Withdraw half
        client.withdraw(&recipient, &recipient, &asset, &5_000_i128);

        assert_eq!(client.get_total_by_asset(&recipient, &asset), 5_000_i128);

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

        // Try to withdraw more than balance
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

        client.initialize(&admin);

        // Try to withdraw without any support received
        client.withdraw(&recipient, &recipient, &asset, &1000_i128);
    }

    #[test]
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

        let count = client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, ""),
        );
        assert_eq!(count, 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #200)")] // Error::ContractPaused
    fn withdraw_fails_when_contract_is_paused() {
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

        client.pause();
        client.withdraw(&recipient, &recipient, &asset, &5_000_i128);
    }

    #[test]
    fn unicode_message_counted_in_chars_not_bytes() {
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

        // 280 Japanese chars = 840 bytes — should pass with char counting
        let japanese_msg = "本".repeat(280);
        let count = client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, &japanese_msg),
        );
        assert_eq!(count, 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")] // Error::MessageTooLong
    fn unicode_message_too_long() {
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

        // 281 Japanese chars = 843 bytes — must fail
        let japanese_msg = "本".repeat(281);
        client.support(
            &supporter,
            &recipient,
            &asset,
            &1000_i128,
            &String::from_str(&e, "XLM"),
            &String::from_str(&e, &japanese_msg),
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
}
