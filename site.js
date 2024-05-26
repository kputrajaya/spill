(() => {
  // Alpine data
  document.addEventListener('alpine:init', () => {
    Alpine.data('spill', function () {
      // Query params operations
      const getParams = () => {
        const params = {};
        const search = window.location.search;
        if (search) {
          search
            .substring(1)
            .split('&')
            .forEach((param) => {
              const [key, value] = param.split('=');
              params[key] = decodeURIComponent(value).replace(/\+/g, ' ').replace(/\|/g, '\n');
            });
        }
        return params;
      };
      const setParams = (params) => {
        const search = Object.keys(params)
          .map((key) => `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+').replace(/%0A/g, '|')}`)
          .join('&');
        window.history.replaceState(null, null, `?${search}`);
      };

      // Settle credits and debts efficiently
      const settleBalances = (balances) => {
        // Separate creditors and debtors
        const creditors = [];
        const debtors = [];
        balances.forEach((balance, index) => {
          if (balance > 0) {
            creditors.push({ index, amount: balance });
          } else if (balance < 0) {
            debtors.push({ index, amount: -balance });
          }
        });

        // Record transactions
        const transactions = [];
        while (true) {
          // Match biggest remaining credit and debt
          const creditor = creditors.sort((a, b) => b.amount - a.amount)[0];
          const debtor = debtors.sort((a, b) => b.amount - a.amount)[0];

          // Maximize transaction amount
          const transactionAmount = Math.min(creditor.amount, debtor.amount);
          if (transactionAmount === 0) {
            if (creditor.amount > 0 || debtor.amount > 0) {
              throw Error('Credits and debts are not equal');
            }
            break;
          }

          transactions.push({ from: debtor.index, to: creditor.index, amount: transactionAmount });
          creditor.amount -= transactionAmount;
          debtor.amount -= transactionAmount;
        }
        return transactions;
      };

      const copyText = async (text) => {
        // Copy using execCommand
        const el = document.createElement('textarea');
        el.style.opacity = 0;
        document.body.appendChild(el);
        el.value = text;
        el.focus();
        el.select();
        const result = document.execCommand && document.execCommand('copy');
        el.remove();
        if (result === true) return true;

        // Copy using navigator.clipboard
        if (navigator.clipboard) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch {}
        }

        return false;
      };

      const notyf = new Notyf({
        ripple: false,
        position: { x: 'center' },
      });

      return {
        // Data
        total: '73150',
        items: '30000 ani\n27500 roy\n9000 ani roy roy',
        error: null,
        billData: null,
        mbrData: this.$persist({ people: [], bills: [] }),

        // Actions
        compute() {
          try {
            if (this.items !== this.items.replace(/\+|\|/g, '')) {
              throw Error('Cannot use "+" or "|" character');
            }

            // Parse total
            const total = Math.floor(this.total.trim());
            if (!(total > 0)) {
              throw Error('Total amount is invalid');
            }

            // Parse items
            const peopleTotal = {};
            let proratedTotal = 0;
            const items = this.items
              .split('\n')
              .map((item) => item.split('-')[0].trim().toUpperCase())
              .filter((item) => item)
              .map((item, itemIndex) => {
                const args = item
                  .split(' ')
                  .map((arg) => arg.trim())
                  .filter((arg) => arg);

                // Parse price
                const price = Math.floor(args[0]);
                if (!(price > 0)) {
                  throw Error(`Item ${itemIndex + 1} has an invalid price`);
                }

                // Parse people
                const people = args.slice(1);
                if (args.length < 2) {
                  throw Error(`Item ${itemIndex + 1} has no valid person name`);
                }
                const proratedPrice = Math.round(price / people.length);
                proratedTotal += proratedPrice * people.length;
                const result = {
                  no: itemIndex + 1,
                  price: price,
                  priceWithFee: null,
                  people: {},
                };
                people.forEach((person) => {
                  result.people[person] = (result.people[person] || 0) + proratedPrice;
                  peopleTotal[person] = 0;
                });
                return result;
              });
            if (!items.length) {
              throw Error('Items are still empty');
            }

            // Calculate and apply fee
            let totalPrice = 0;
            let totalPriceWithFee = 0;
            const feePercentage = (total - proratedTotal) / proratedTotal;
            items.forEach((item) => {
              item.priceWithFee = Math.round(item.price * (1 + feePercentage));
              Object.keys(item.people).forEach((person) => {
                item.people[person] = Math.round(item.people[person] * (1 + feePercentage));
                peopleTotal[person] += item.people[person];
              });
              totalPrice += item.price;
              totalPriceWithFee += item.priceWithFee;
            });

            // Save to bill data
            this.error = null;
            this.billData = {
              people: Object.keys(peopleTotal).sort(),
              feePercentage: Math.round(feePercentage * 1000) / 10,
              items,
              totalPrice,
              totalPriceWithFee,
              peopleTotal,
            };
            setParams({
              total: this.total,
              items: this.items,
            });
          } catch (e) {
            this.error = e.message;
            this.billData = null;
          }
        },
        async copy() {
          if (!this.billData?.people?.length) return;

          // Prepare summary
          let summary = `TOTAL: ${this.formatNumber(this.billData.totalPriceWithFee)}\r\n===`;
          this.billData.people.forEach((person) => {
            const personTotal = this.billData.peopleTotal[person];
            if (personTotal > 0) {
              summary += `\r\n${person}: ${this.formatNumber(personTotal)}`;
            }
          });

          // Copy to clipboard
          const result = await copyText(summary);
          result ? notyf.success('Summary copied') : notyf.error('Cannot access clipboard');
        },
        async share() {
          if (!this.billData?.people?.length) return;

          if (navigator.share) {
            // Share using Web Share API
            await navigator.share({ url: location.href });
          } else {
            // Copy to clipboard
            const result = await copyText(location.href);
            result ? notyf.success('Link copied') : notyf.error('Cannot access clipboard');
          }
        },
        mbrSave() {
          const peopleCount = this.billData?.people?.length;
          if (!peopleCount) return;

          // Ask for payer info
          const nameList = this.billData.people.map((person, index) => `${index + 1}. ${person}`).join('\n');
          const payerNum = Math.floor(
            prompt(`Stacking the bill above to be settled later. Who paid? (1 - ${peopleCount})?\n${nameList}`)
          );
          const payer = this.billData.people[payerNum - 1];
          if (!payer) {
            notyf.error(`Please input number 1 - ${peopleCount}`);
            return;
          }

          // Ask for bill note
          const note = (prompt('Put an optional description for this bill:') || '').trim();

          // Record bill into MBR data
          this.mbrData.people = [...new Set([...this.mbrData.people, ...this.billData.people])].sort();
          this.mbrData.bills.push({
            payer,
            note,
            totalPriceWithFee: this.billData.totalPriceWithFee,
            peopleTotal: this.billData.peopleTotal,
          });
          notyf.success('Bill saved to stack');
        },
        mbrClear() {
          if (!confirm('Remove all stacked bills?')) return;
          this.mbrData = { people: [], bills: [] };
          notyf.success('Bills cleared');
        },
        mbrListBalances() {
          const balanceMap = {};
          this.mbrData.bills.forEach((bill) => {
            Object.keys(bill.peopleTotal).forEach((payee) => {
              if (bill.payer === payee) return;
              balanceMap[bill.payer] = balanceMap[bill.payer] || { credit: 0, debt: 0 };
              balanceMap[bill.payer].credit += bill.peopleTotal[payee];
              balanceMap[payee] = balanceMap[payee] || { credit: 0, debt: 0 };
              balanceMap[payee].debt += bill.peopleTotal[payee];
            });
          });
          return this.mbrData.people.map((person) => balanceMap[person] || 0);
        },
        mbrSettle() {
          const balances = this.mbrListBalances().map((person) => person.credit - person.debt);
          const transactions = settleBalances(balances).map((transaction) => ({
            from: this.mbrData.people[transaction.from],
            to: this.mbrData.people[transaction.to],
            amount: transaction.amount,
          }));
          return transactions;
        },
        async mbrCopy() {
          if (!this.mbrData?.people?.length) return;

          // Prepare summary
          const total = this.mbrData.bills.reduce((acc, cur) => acc + cur.totalPriceWithFee, 0);
          let summary = `TOTAL (${this.mbrData.bills.length}): ${this.formatNumber(total)}\r\n===`;
          this.mbrSettle().forEach((transaction) => {
            summary += `\r\n${transaction.from} -> ${transaction.to}: ${this.formatNumber(transaction.amount)}`;
          });

          // Copy to clipboard
          const result = await copyText(summary);
          result ? notyf.success('Summary copied') : notyf.error('Cannot access clipboard');
        },

        // Helpers
        select(e) {
          e.target.select();
        },
        formatNumber(num) {
          return num != null ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
        },

        init() {
          // Restore from params
          const params = getParams();
          this.total = params.total || this.total;
          this.items = params.items || this.items;

          // Compute and watch
          this.compute();
          this.$watch('total', () => this.compute());
          this.$watch('items', () => this.compute());

          // Resize textarea and watch
          const elItems = document.getElementById('itemsInput');
          elItems.addEventListener(
            'input',
            (e) => {
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            },
            false
          );
          setTimeout(() => {
            elItems.dispatchEvent(new Event('input'));
          }, 0);
        },
      };
    });
  });
})();
