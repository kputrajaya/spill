(() => {
  // Alpine data
  document.addEventListener('alpine:init', () => {
    const notyf = new Notyf({
      ripple: false,
      position: { x: 'center' },
    });

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
          creditors.push({ index, amount: balance });
        } else if (balance < 0) {
          debtors.push({ index, amount: -balance });
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
        roundDecimals: this.$persist(true),

        // Actions
        compute() {
          setParams({
            total: this.total,
            items: this.items,
            people: this.people,
          });

          try {
            if (this.items !== this.items.replace(/\+|\|/g, '')) {
              throw Error('Do not use restricted characters: +|');
            }

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
              .map((people) => people.trim().toUpperCase())
              .filter((people) => people)
              .map((people, peopleIndex) => {
                const names = people.split(' ').filter((arg) => arg);
                if (!names.length) {
                  throw Error(`Enter a valid name for item ${peopleIndex + 1}`);
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

          fileInput.click();
          fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            notyf.success('Processing, this might take a while');

            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = async () => {
              // Calculate new width and height
              const maxPx = 1200;
              const newWidth = img.width > img.height ? maxPx : Math.round((img.width / img.height) * maxPx);
              const newHeight = img.width > img.height ? Math.round((img.height / img.width) * maxPx) : maxPx;

              // Set canvas dimensions
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(img.width, newWidth);
              canvas.height = Math.min(img.height, newHeight);

              // Use Pica to resize the image
              await pica().resize(img, canvas);
              const blob = await pica().toBlob(canvas, 'image/jpeg', 0.7);

              // Upload to API
              const formData = new FormData();
              formData.append('file', blob, file.name + '.res.jpg');
              fetch('/api/upload', { method: 'POST', body: formData })
                .then((res) => res.json())
                .then((data) => {
                  if (!data || !data.total || !data.items) throw new Error();
                  this.total = `${this.parseAmount(data.total)}`;
                  this.items = data.items
                    .map((item) => {
                      const amount = this.parseAmount(item.amount);
                      const name = item.name.replace(/[^\w]/g, ' ').replace(/\s+/g, ' ').trim();
                      return `${amount} - ${name}`;
                    })
                    .join('\n');
                  this.people = '';
                  this.resizeTextArea();
                  notyf.success('Data extracted, please verify');
                })
                .catch((err) => {
                  console.log('Image uploaded error:', err);
                  notyf.error('Failed to extract data');
                })
                .finally(() => {
                  document.body.removeChild(fileInput);
                });
            };
          });
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
          result ? notyf.success('Summary copied') : notyf.error('Cannot access clipboard');
        },
        async copyLink() {
          if (!this.billData?.people?.length) return;

          // Copy to clipboard
          const result = await copyText(location.href);
          result ? notyf.success('Link copied') : notyf.error('Cannot access clipboard');
        },
        mbrSave() {
          const peopleCount = this.billData?.people?.length;
          if (!peopleCount) return;

          // Ask for payer info
          const nameList = this.billData.people.map((person, index) => `${index + 1}. ${person}`).join('\n');
          const payerInfo = (
            prompt(`Stacking the bill above to be settled later. Who paid? (1 - ${peopleCount})?\n${nameList}`) || ''
          ).toUpperCase();
          const payer =
            this.billData.people[Math.floor(payerInfo) - 1] ||
            this.billData.people.find((person) => person === payerInfo);
          if (!payer) {
            notyf.error(`Please input number 1 - ${peopleCount}`);
            return;
          }

          // Ask for bill note
          const note = (prompt('Put an optional description for this bill:') || formatDate(new Date())).trim();

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
        mbrDelete(index) {
          if (!confirm('Delete this bill?')) return;
          this.mbrData.bills.splice(index, 1);
        },
        mbrClear() {
          if (!confirm('Delete all stacked bills?')) return;
          this.mbrData = { people: [], bills: [] };
          notyf.success('Bills cleared');
        },
        mbrListBalances() {
          const balanceMap = Object.fromEntries(this.mbrData.people.map((person) => [person, { credit: 0, debt: 0 }]));
          this.mbrData.bills.forEach((bill) => {
            Object.keys(bill.peopleTotal).forEach((payee) => {
              if (bill.payer === payee) return;
              balanceMap[bill.payer].credit += bill.peopleTotal[payee];
              balanceMap[payee].debt += bill.peopleTotal[payee];
            });
          });
          return this.mbrData.people.map((person) =>
            this.parseAmount(balanceMap[person].credit - balanceMap[person].debt)
          );
        },
        mbrSettle() {
          const balances = this.mbrListBalances();
          const transactions = settleBalances(balances).map((transaction) => ({
            from: this.mbrData.people[transaction.from],
            to: this.mbrData.people[transaction.to],
            amount: this.parseAmount(transaction.amount),
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
        parseAmount(amount) {
          const parsed = parseFloat(amount) || 0;
          const factor = this.roundDecimals ? 1 : 100;
          return Math.round(parsed * factor) / factor;
        },
        formatNumber(num) {
          const decimals = this.roundDecimals ? 0 : 2;
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
          this.compute();
          this.$watch('total', () => this.compute());
          this.$watch('items', () => this.compute());
          this.$watch('people', () => this.compute());
          this.$watch('roundDecimals', () => this.compute());

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
