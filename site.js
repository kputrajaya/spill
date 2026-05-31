(() => {
  const MAX_PX = 1200;
  const JPEG_QUALITY = 0.7;

  document.addEventListener('alpine:init', () => {
    const notyf = new Notyf({
      ripple: false,
      position: { x: 'center' },
    });

    const getParams = () => {
      const params = {};
      const search = window.location.search;
      if (search) {
        search.substring(1).split('&').forEach((param) => {
          const idx = param.indexOf('=');
          if (idx === -1) return;
          params[param.slice(0, idx)] = decodeURIComponent(param.slice(idx + 1));
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
    const formatDate = (date) => {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = monthNames[date.getMonth()];
      const day = date.getDate();
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${month} ${day}, ${hours}:${minutes}`;
    };
    const settleBalances = (balances) => {
      // Separate creditors and debtors then sort them
      const creditors = [];
      const debtors = [];
      balances.forEach((balance, index) => {
    if (balance > 0) {
      debtors.push({ index, amount: balance });
    } else if (balance < 0) {
      creditors.push({ index, amount: -balance });
    }
      });
      creditors.sort((a, b) => b.amount - a.amount);
      debtors.sort((a, b) => b.amount - a.amount);

      const transactions = [];
      while (creditors.length && debtors.length) {
        // Match the biggest credit and debt
        const creditor = creditors[0];
        const debtor = debtors[0];
        const transaction = {
          from: debtor.index,
          to: creditor.index,
          amount: Math.min(creditor.amount, debtor.amount),
        };
        transactions.push(transaction);

        // Prepare the lists for the next pass
        if (creditor.amount === transaction.amount) {
          creditors.shift();
        } else {
          creditor.amount = creditor.amount - transaction.amount;
          creditors.sort((a, b) => b.amount - a.amount);
        }
        if (debtor.amount === transaction.amount) {
          debtors.shift();
        } else {
          debtor.amount = debtor.amount - transaction.amount;
          debtors.sort((a, b) => b.amount - a.amount);
        }
      }

      return transactions;
    };
    const copyText = async (text) => {
      // Use execCommand
      const el = document.createElement('textarea');
      el.style.opacity = 0;
      document.body.appendChild(el);
      el.value = text;
      el.focus();
      el.select();
      const result = document.execCommand && document.execCommand('copy');
      el.remove();
      if (result === true) return true;

      // Use navigator.clipboard
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {}
      }

      return false;
    };

    Alpine.data('spill', function () {
      return {
        // Data
        total: '73150',
        items: '30000\n27500\n9000',
        people: 'ani\nroy\nani roy roy',
        error: null,
        billData: null,
        mbrData: this.$persist({ people: [], bills: [] }),
        mbrComputed: null,
        roundDecimals: this.$persist(true),

        // Actions
        compute() {
          setParams({
            total: this.total,
            items: this.items,
            people: this.people,
          });

          try {
            // Parse total
            const total = this.parseAmount(this.total.trim());
            if (!(total > 0)) {
              throw Error('Enter a valid total');
            }

            // Parse items (price) and people (array of names)
            const items = this.items
              .split('\n')
              .map((item) => item.trim().split(' ')[0])
              .filter((item) => item)
              .map((item, itemIndex) => {
                const price = this.parseAmount(item);
                if (!(price > 0)) {
                  throw Error(`Enter a valid price for item ${itemIndex + 1}`);
                }
                return price;
              });
            if (!items.length) {
              throw Error('Fill in items information');
            }
            const people = this.people
              .split('\n')
              .map((line) => line.trim().toUpperCase())
              .filter((line) => line)
              .map((line, i) => {
                const names = line.split(' ').filter((arg) => arg);
                if (!names.length) {
                  throw Error(`Enter a valid name for item ${i + 1}`);
                }
                return names;
              });
            if (!people.length) {
              throw Error('Fill in people information');
            }
            if (items.length !== people.length) {
              throw Error('Ensure the number of items and people match');
            }

            // Calculate fee
            const itemsTotal = items.reduce((sum, item) => sum + item, 0);
            const feePercentage = (total - itemsTotal) / itemsTotal;
            const peopleTotal = {};
            let totalPrice = 0;
            let totalPriceWithFee = 0;
            const data = items.map((item, itemIndex) => {
              const datum = {
                no: itemIndex + 1,
                price: this.parseAmount(item),
                priceWithFee: this.parseAmount(item * (1 + feePercentage)),
                people: {},
              };
              const proratedPrice = item / people[itemIndex].length;
              people[itemIndex].forEach((person) => {
                const proratedPriceWithFee = proratedPrice * (1 + feePercentage);
                datum.people[person] = this.parseAmount((datum.people[person] || 0) + proratedPriceWithFee);
                peopleTotal[person] = this.parseAmount((peopleTotal[person] || 0) + proratedPriceWithFee);
              });
              totalPrice += datum.price;
              totalPriceWithFee += datum.priceWithFee;
              return datum;
            });

            // Save to bill data
            this.error = null;
            this.billData = {
              people: Object.keys(peopleTotal).sort(),
              feePercentage: Math.round(feePercentage * 1000) / 10,
              items: data,
              totalPrice: this.parseAmount(totalPrice),
              totalPriceWithFee: this.parseAmount(totalPriceWithFee),
              peopleTotal,
            };
          } catch (err) {
            this.error = err.message;
            this.billData = null;
          }
        },
        uploadImage() {
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = 'image/*,text/plain';
          fileInput.style.display = 'none';
          document.body.appendChild(fileInput);

          fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            document.body.removeChild(fileInput);
            if (!file) return;

            notyf.success('Processing, this might take a while...');

            const img = new Image();
            img.onload = async () => {
              URL.revokeObjectURL(img.src);
              const newWidth = img.width > img.height ? MAX_PX : Math.round((img.width / img.height) * MAX_PX);
              const newHeight = img.width > img.height ? Math.round((img.height / img.width) * MAX_PX) : MAX_PX;

              const canvas = document.createElement('canvas');
              canvas.width = Math.min(img.width, newWidth);
              canvas.height = Math.min(img.height, newHeight);

              const blob = await pica().resize(img, canvas).toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
              const formData = new FormData();
              formData.append('file', blob, file.name + '.res.jpg');
              try {
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if (!data || !data.total || !data.items) throw new Error();
                this.total = `${this.parseAmount(data.total)}`;
                this.items = data.items
                  .map((item) => {
                    const amount = this.parseAmount(item.amount);
                    const name = (item.name || '').replace(/[^\w]/g, ' ').replace(/\s+/g, ' ').trim();
                    return `${amount} - ${name}`;
                  })
                  .join('\n');
                this.people = '';
                this.resizeTextArea();
                notyf.success('Data extracted, please verify!');
              } catch {
                notyf.error('Failed to extract data!');
              }
            };
            img.onerror = () => {
              URL.revokeObjectURL(img.src);
              notyf.error('Failed to load image!');
            };
            img.src = URL.createObjectURL(file);
          });

          fileInput.click();
        },
        async copySummary() {
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
          result ? notyf.success('Split summary copied!') : notyf.error('Cannot access clipboard!');
        },
        async copyLink() {
          if (!this.billData?.people?.length) return;

          // Copy to clipboard
          const result = await copyText(location.href);
          result ? notyf.success('Shareable link copied!') : notyf.error('Cannot access clipboard!');
        },
        mbrSave() {
          const peopleCount = this.billData?.people?.length;
          if (!peopleCount) return;

          // Ask for payer info
          const nameList = this.billData.people.map((person, index) => `${index + 1}. ${person}`).join('\n');
          const payerInfo = (
            prompt(`Saving the bill above to settle later. Who paid? (1–${peopleCount})\n${nameList}`) || ''
          ).toUpperCase();
          const payer =
            this.billData.people[Math.floor(payerInfo) - 1] ||
            this.billData.people.find((person) => person === payerInfo);
          if (!payer) {
            notyf.error(`Please input number 1–${peopleCount}!`);
            return;
          }

          // Ask for bill note
          const note = (prompt('Put optional description for this bill:') || formatDate(new Date())).trim();

          // Record bill into MBR data
          this.mbrData.people = [...new Set([...this.mbrData.people, ...this.billData.people])].sort();
          this.mbrData.bills.push({
            payer,
            note,
            totalPriceWithFee: this.billData.totalPriceWithFee,
            peopleTotal: this.billData.peopleTotal,
          });
          this.mbrCompute();
          notyf.success('Current bill saved!');
        },
        mbrDelete(index) {
          if (!confirm('Delete this bill?')) return;
          this.mbrData.bills.splice(index, 1);
          this.mbrCompute();
        },
        mbrClear() {
          if (!this.mbrData?.bills?.length) {
            notyf.error('No bills to clear!');
            return;
          }

          if (!confirm('Delete all saved bills?')) return;
          this.mbrData = { people: [], bills: [] };
          this.mbrComputed = null;
          notyf.success('All bills deleted!');
        },
        mbrCompute() {
          if (!this.mbrData?.bills?.length) {
            this.mbrComputed = null;
            return;
          }

          const people = this.mbrData.people;
          const bills = this.mbrData.bills;
          const spent = people.map(() => 0);
          const paid = people.map(() => 0);
          const balanceMap = Object.fromEntries(people.map((p) => [p, { credit: 0, debt: 0 }]));
          let totalSpentAll = 0;

          bills.forEach((bill) => {
            totalSpentAll += bill.totalPriceWithFee;
            people.forEach((person, i) => {
              spent[i] += bill.peopleTotal[person] || 0;
              if (bill.payer === person) paid[i] += bill.totalPriceWithFee;
            });
            Object.keys(bill.peopleTotal).forEach((payee) => {
              if (bill.payer === payee) return;
              balanceMap[bill.payer].credit += bill.peopleTotal[payee];
              balanceMap[payee].debt += bill.peopleTotal[payee];
            });
          });

          const listBalances = people.map((person) =>
            this.parseAmount(balanceMap[person].debt - balanceMap[person].credit)
          );

          this.mbrComputed = {
            totalSpentAll: this.parseAmount(totalSpentAll),
            listTotalSpent: spent.map((v) => this.parseAmount(v)),
            listTotalPaid: paid.map((v) => this.parseAmount(v)),
            listBalances,
            settle: settleBalances(listBalances).map((t) => ({
              from: people[t.from],
              to: people[t.to],
              amount: this.parseAmount(t.amount),
            })),
          };
        },
        async mbrCopy() {
          if (!this.mbrComputed) return;

          // Prepare summary
          const total = this.mbrComputed.totalSpentAll;
          let summary = `TOTAL (${this.mbrData.bills.length}): ${this.formatNumber(total)}\r\n===`;
          this.mbrComputed.settle.forEach((transaction) => {
            summary += `\r\n${transaction.from} -> ${transaction.to}: ${this.formatNumber(transaction.amount)}`;
          });

          // Copy to clipboard
          const result = await copyText(summary);
          result ? notyf.success('Settlement summary copied!') : notyf.error('Cannot access clipboard!');
        },

        // Helpers
        select(e) {
          e.target.select();
        },
        parseAmount(amount) {
          const parsed = parseFloat(amount) || 0;
          const factor = this.roundDecimals ? 1 : 100;
          return Math.round(parsed * factor) / factor;
        },
        formatNumber(num, decimals = null) {
          if (decimals === null) {
            decimals = this.roundDecimals ? 0 : 2;
          }
          return num != null ? num.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
        },
        resizeTextArea() {
          setTimeout(() => {
            const els = document.querySelectorAll('.list-input');
            let maxHeight = 0;
            els.forEach((el) => {
              el.style.height = 'auto';
              maxHeight = Math.max(maxHeight, el.scrollHeight);
            });
            els.forEach((el) => {
              el.style.height = maxHeight + 'px';
            });
          }, 0);
        },

        init() {
          // Restore from params
          const params = getParams();
          if (params.total != null) this.total = params.total;
          if (params.items != null) this.items = params.items;
          if (params.people != null) this.people = params.people;

          // Compute and watch
          this.mbrCompute();
          this.compute();
          this.$watch('total', () => this.compute());
          this.$watch('items', () => this.compute());
          this.$watch('people', () => this.compute());
          this.$watch('roundDecimals', () => {
            this.compute();
            this.mbrCompute();
          });

          // Resize textarea and watch
          this.resizeTextArea();
          document.querySelectorAll('.list-input').forEach((el) => {
            el.addEventListener('input', () => this.resizeTextArea(), false);
          });
        },
      };
    });
  });
})();
