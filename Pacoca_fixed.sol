// Sources flattened with hardhat v2.3.0 https://hardhat.org

// File @openzeppelin/contracts/utils/Context.sol@v3.4.1

pragma solidity >=0.6.0 <0.8.0;

abstract contract Context {
    function _msgSender() internal view virtual returns (address payable) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes memory) {
        this;
        return msg.data;
    }
}

// File @openzeppelin/contracts/token/ERC20/IERC20.sol@v3.4.1

pragma solidity >=0.6.0 <0.8.0;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

// File @openzeppelin/contracts/math/SafeMath.sol@v3.4.1

pragma solidity >=0.6.0 <0.8.0;

library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a, "SafeMath: addition overflow");
        return c;
    }

    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a, "SafeMath: subtraction overflow");
        return a - b;
    }

    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) return 0;
        uint256 c = a * b;
        require(c / a == b, "SafeMath: multiplication overflow");
        return c;
    }

    function div(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0, "SafeMath: division by zero");
        return a / b;
    }

    function mod(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0, "SafeMath: modulo by zero");
        return a % b;
    }
}

// File @openzeppelin/contracts/token/ERC20/ERC20.sol@v3.4.1

pragma solidity >=0.6.0 <0.8.0;

contract ERC20 is Context, IERC20 {
    using SafeMath for uint256;

    mapping (address => uint256) private _balances;
    mapping (address => mapping (address => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;
    uint8 private _decimals;

    constructor (string memory name_, string memory symbol_) public {
        _name = name_;
        _symbol = symbol_;
        _decimals = 18;
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function decimals() public view virtual returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view virtual override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view virtual override returns (uint256) {
        return _balances[account];
    }

    function transfer(address recipient, uint256 amount) public virtual override returns (bool) {
        _transfer(_msgSender(), recipient, amount);
        return true;
    }

    function allowance(address owner, address spender) public view virtual override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) public virtual override returns (bool) {
        _approve(_msgSender(), spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) public virtual override returns (bool) {
        _transfer(sender, recipient, amount);
        _approve(sender, _msgSender(), _allowances[sender][_msgSender()].sub(amount, "ERC20: transfer amount exceeds allowance"));
        return true;
    }

    function increaseAllowance(address spender, uint256 addedValue) public virtual returns (bool) {
        _approve(_msgSender(), spender, _allowances[_msgSender()][spender].add(addedValue));
        return true;
    }

    function decreaseAllowance(address spender, uint256 subtractedValue) public virtual returns (bool) {
        _approve(_msgSender(), spender, _allowances[_msgSender()][spender].sub(subtractedValue, "ERC20: decreased allowance below zero"));
        return true;
    }

    function _transfer(address sender, address recipient, uint256 amount) internal virtual {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");

        _beforeTokenTransfer(sender, recipient, amount);

        _balances[sender] = _balances[sender].sub(amount, "ERC20: transfer amount exceeds balance");
        _balances[recipient] = _balances[recipient].add(amount);
        emit Transfer(sender, recipient, amount);
    }

    function _mint(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: mint to the zero address");

        _beforeTokenTransfer(address(0), account, amount);

        _totalSupply = _totalSupply.add(amount);
        _balances[account] = _balances[account].add(amount);
        emit Transfer(address(0), account, amount);
    }

    function _burn(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: burn from the zero address");

        _beforeTokenTransfer(account, address(0), amount);

        _balances[account] = _balances[account].sub(amount, "ERC20: burn amount exceeds balance");
        _totalSupply = _totalSupply.sub(amount);
        emit Transfer(account, address(0), amount);
    }

    function _approve(address owner, address spender, uint256 amount) internal virtual {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _setupDecimals(uint8 decimals_) internal virtual {
        _decimals = decimals_;
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal virtual { }
}

// File @openzeppelin/contracts/access/Ownable.sol@v3.4.1

pragma solidity >=0.6.0 <0.8.0;

abstract contract Ownable is Context {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor () internal {
        address msgSender = _msgSender();
        _owner = msgSender;
        emit OwnershipTransferred(address(0), msgSender);
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    modifier onlyOwner() {
        require(owner() == _msgSender(), "Ownable: caller is not the owner");
        _;
    }

    function renounceOwnership() public virtual onlyOwner {
        emit OwnershipTransferred(_owner, address(0));
        _owner = address(0);
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}

// File contracts/Pacoca_fixed.sol

// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

contract Pacoca is ERC20("Pacoca", "PACOCA"), Ownable {
    // ============ ZABEZPIECZENIA MINTOWANIA ============
    
    // Maksymalna całkowita podaż tokenów (np. 1 miliard)
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    
    // Dzienny limit mintowania (np. 100,000 tokenów dziennie)
    uint256 public dailyMintLimit = 100_000 * 10**18;
    
    // Ostatni czas mintowania
    uint256 public lastMintTime;
    
    // Ilość zmintowanych tokenów dzisiaj
    uint256 public mintedToday;
    
    // Czy mintowanie jest włączone
    bool public mintingEnabled = true;

    // ============ ZDARZENIA ============
    
    event MintingStatusChanged(bool enabled);
    event DailyMintLimitChanged(uint256 newLimit);
    event TokensMinted(address indexed to, uint256 amount, uint256 timestamp);

    // ============ FUNKCJA MINT Z ZABEZPIECZENIAMI ============
    
    function mint(address _to, uint256 _amount) public onlyOwner {
        require(mintingEnabled, "Minting is currently disabled");
        require(_to != address(0), "Cannot mint to zero address");
        require(_amount > 0, "Amount must be greater than 0");
        
        // Sprawdź czy nie przekraczamy MAX_SUPPLY
        require(totalSupply() + _amount <= MAX_SUPPLY, "Would exceed maximum supply");
        
        // Resetuj dzienny licznik jeśli minął dzień
        if (block.timestamp > lastMintTime + 1 days) {
            mintedToday = 0;
            lastMintTime = block.timestamp;
        }
        
        // Sprawdź dzienny limit
        require(mintedToday + _amount <= dailyMintLimit, "Would exceed daily mint limit");
        
        // Wykonaj mint
        _mint(_to, _amount);
        
        // Zaktualizuj dzienny licznik
        mintedToday += _amount;
        
        emit TokensMinted(_to, _amount, block.timestamp);
    }

    // ============ FUNKCJE ADMINISTRACYJNE ============
    
    /**
     * @dev Włącza lub wyłącza mintowanie
     */
    function setMintingEnabled(bool _enabled) public onlyOwner {
        mintingEnabled = _enabled;
        emit MintingStatusChanged(_enabled);
    }
    
    /**
     * @dev Zmienia dzienny limit mintowania
     */
    function setDailyMintLimit(uint256 _newLimit) public onlyOwner {
        require(_newLimit > 0, "Daily limit must be greater than 0");
        dailyMintLimit = _newLimit;
        emit DailyMintLimitChanged(_newLimit);
    }
    
    /**
     * @dev Pobiera informacje o aktualnym statusie mintowania
     */
    function getMintingStatus() public view returns (
        bool enabled,
        uint256 currentDailyLimit,
        uint256 mintedTodayAmount,
        uint256 remainingToday,
        uint256 totalMintable
    ) {
        uint256 remaining = dailyMintLimit;
        
        // Reset licznika jeśli minął dzień
        if (block.timestamp > lastMintTime + 1 days) {
            remaining = dailyMintLimit;
        } else {
            remaining = dailyMintLimit - mintedToday;
        }
        
        return (
            mintingEnabled,
            dailyMintLimit,
            block.timestamp > lastMintTime + 1 days ? 0 : mintedToday,
            remaining,
            MAX_SUPPLY - totalSupply()
        );
    }
}