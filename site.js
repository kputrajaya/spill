(() => {
  // Helper functions
  const getQueryParams = () => {
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
  const setQueryParams = (params) => {
    const search = Object.keys(params)
      .map((key) => `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+').replace(/%0A/g, '|')}`)
      .join('&');
    window.history.replaceState(null, null, `?${search}`);
  };
  const robustCopy = async (text) => {
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

  // Text area auto-resize
  const textarea = document.getElementById('itemsInput');
  const resizeItemsInput = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', resizeItemsInput, false);

  // Initialize Notyf
  const notyf = new Notyf({
    ripple: false,
    position: { x: 'center' },
  });

  // Alpine data
  document.addEventListener('alpine:init', () => {
    Alpine.data('spill', function () {
      return {
        // Data
        total: '73150',
        items: '30000 ani\n27500 roy\n9000 ani roy roy',
        error: null,
        billData: null,
        mbrData: this.$persist({ people: [], bills: [], map: {} }),

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
            setQueryParams({
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
          let summary = `TOTAL: ${this.formatNumber(this.billData.totalPriceWithFee)}\r\===`;
          this.billData.people.forEach((person) => {
            const personTotal = this.billData.peopleTotal[person];
            if (personTotal > 0) {
              summary += `\r\n${person}: ${this.formatNumber(personTotal)}`;
            }
          });

          // Copy summary to clipboard
          const result = await robustCopy(summary);
          if (result) {
            notyf.success('Summary copied!');
          } else {
            notyf.error('Cannot access clipboard!');
          }
        },
        async share() {
          if (!this.billData?.people?.length) return;

          if (navigator.share) {
            // Share link using Web Share API
            await navigator.share({ url: location.href });
          } else {
            // Copy link to clipboard
            const result = await robustCopy(location.href);
            if (result) {
              notyf.success('Link copied!');
            } else {
              notyf.error('Cannot access clipboard!');
            }
          }
        },
        mbrSave() {
          const peopleCount = this.billData?.people?.length;
          if (!peopleCount) return;

          // Ask for payer info
          const nameList = this.billData.people.map((person, index) => `${index + 1}. ${person}`).join('\n');
          const payerInput = prompt(`Who paid the bill above (1 - ${peopleCount})?\n${nameList}`);
          const payer = this.billData.people[Math.floor(payerInput) - 1];
          if (!payer) {
            notyf.error(`Please input number 1 - ${peopleCount}!`);
            return;
          }

          // Record bill into MBR data
          this.mbrData.people = [...new Set([...this.mbrData.people, ...this.billData.people])].sort();
          this.mbrData.bills.push({
            payer,
            totalPriceWithFee: this.billData.totalPriceWithFee,
            peopleTotal: this.billData.peopleTotal,
          });

          // Recalculate payer-payee map
          this.mbrData.map = {};
          this.mbrData.bills.forEach((bill) => {
            this.mbrData.map[bill.payer] = this.mbrData.map[bill.payer] || {};
            Object.keys(bill.peopleTotal).forEach((person) => {
              this.mbrData.map[bill.payer][person] = this.mbrData.map[bill.payer][person] || 0;
              this.mbrData.map[bill.payer][person] += bill.peopleTotal[person];
            });
          });
        },
        mbrClear() {
          if (!confirm('Remove all stacked bills?')) return;
          this.mbrData = { people: [], bills: [], map: {} };
        },
        mbrGetDebt(payer, payee) {
          const toPay = (this.mbrData.map[payee] || {})[payer] || 0;
          const toReceive = (this.mbrData.map[payer] || {})[payee] || 0;
          return Math.max(0, toPay - toReceive);
        },
        async mbrCopy() {
          if (!this.mbrData?.people?.length) return;

          // Prepare summary
          const total = this.mbrData.bills.reduce((acc, cur) => acc + cur.totalPriceWithFee, 0);
          let summary = `STACK TOTAL: ${this.formatNumber(total)}\r===`;
          this.mbrData.people.forEach((payer) => {
            this.mbrData.people.forEach((payee) => {
              const debt = payer !== payee ? this.mbrGetDebt(payer, payee) : 0;
              if (debt > 0) {
                summary += `\r\n${payer} pays ${payee}: ${this.formatNumber(debt)}`;
              }
            });
          });

          // Copy summary to clipboard
          const result = await robustCopy(summary);
          if (result) {
            notyf.success('Summary copied!');
          } else {
            notyf.error('Cannot access clipboard!');
          }
        },

        // Helpers
        select(e) {
          e.target.select();
        },
        formatNumber(num) {
          return num != null ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
        },

        init() {
          const params = getQueryParams();
          this.total = params.total || this.total;
          this.items = params.items || this.items;
          this.compute();
          this.$watch('total', () => this.compute());
          this.$watch('items', () => this.compute());
          setTimeout(resizeItemsInput, 0);
        },
      };
    });
  });
})();
